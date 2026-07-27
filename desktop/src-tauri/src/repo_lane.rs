//! The repo-job lane: this machine works GitHub repo jobs for real money.
//!
//! Every other lane (text, image, audio) is one prompt in, one artifact out,
//! so the Miner can drive it directly. A repo job is not that shape — it needs
//! a clone, a multi-step edit loop, and a `git diff` — so this lane delegates
//! the actual coding to **Foreman** (`npx @kairose-master/foreman work`), which
//! already does exactly that under a hard budget, and confines itself to the
//! two things a desktop app is uniquely able to provide:
//!
//!   1. **Consent to a folder.** Nothing clones until the owner has picked a
//!      workspace directory. That directory is the permission boundary, and it
//!      is stored so the choice is made once rather than nagged.
//!   2. **An honest readiness check.** Node, Foreman and model credentials are
//!      all things the machine either has or does not; reporting exactly which
//!      one is missing beats a lane that silently never earns.
//!
//! The worker secret this app already holds is passed to Foreman through the
//! environment, never through argv — arguments are visible to every other
//! process on the machine in `ps`.
//!
//! Safety inherited from the platform, not re-implemented here: the worker
//! receives no repository credentials, clones only public repos, and returns a
//! diff. Nothing in this file can push.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

/// What the lane needs before it can earn, and which parts are present.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RepoLaneReadiness {
    pub node: Option<String>,
    /// A model credential Foreman can use. We only report presence.
    pub has_model_credentials: bool,
    pub workspace: Option<String>,
    pub ready: bool,
    /// One sentence naming the single next thing to fix, or why it is ready.
    pub detail: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RepoRunResult {
    pub status: String,
    pub job_id: Option<String>,
    pub repo: Option<String>,
    pub bounty_usd: Option<f64>,
    pub cost_usd: Option<f64>,
    pub verdict: Option<String>,
    pub note: Option<String>,
    /// Raw stderr when the run failed, so a user can paste something useful.
    pub error: Option<String>,
}

fn err_result(status: &str, note: String, error: Option<String>) -> RepoRunResult {
    RepoRunResult {
        status: status.to_string(),
        job_id: None,
        repo: None,
        bounty_usd: None,
        cost_usd: None,
        verdict: None,
        note: Some(note),
        error,
    }
}

/// `node --version`, or None when Node is not on PATH.
async fn node_version() -> Option<String> {
    let out = Command::new("node").arg("--version").output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Foreman reads credentials from the environment or a prior `ant auth login`.
/// We check only the environment: it is the part this app can actually see.
fn has_model_credentials() -> bool {
    ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
        .iter()
        .any(|k| std::env::var(k).map(|v| !v.trim().is_empty()).unwrap_or(false))
}

pub async fn readiness(workspace: Option<PathBuf>) -> RepoLaneReadiness {
    let node = node_version().await;
    let creds = has_model_credentials();
    let workspace_ok = workspace.as_deref().map(Path::exists).unwrap_or(false);

    let detail = if node.is_none() {
        "Node.js is not installed — the repo lane runs Foreman (npx), which needs it. Install Node 20+ and reopen this tab."
            .to_string()
    } else if !creds {
        "No model credentials found. Set ANTHROPIC_API_KEY in your environment so Foreman can do the work, then reopen this tab."
            .to_string()
    } else if !workspace_ok {
        "Choose a workspace folder. Repo jobs are cloned into it and nothing outside it is ever touched.".to_string()
    } else {
        "Ready. Repo jobs are cloned into your workspace, worked under a budget capped by the bounty, and submitted as a diff."
            .to_string()
    };

    RepoLaneReadiness {
        ready: node.is_some() && creds && workspace_ok,
        node,
        has_model_credentials: creds,
        workspace: workspace.map(|p| p.display().to_string()),
        detail,
    }
}

/// Run exactly one repo job to completion via Foreman.
///
/// `--json` makes Foreman's last stdout line a machine-readable result, which
/// is what the UI renders. A missing/oddly-shaped payload is reported as such
/// rather than guessed at — claiming a job and then lying about the outcome
/// would be worse than saying nothing.
pub async fn run_once(
    platform_url: &str,
    agent_id: &str,
    secret: &str,
    workspace: &Path,
    min_bounty_usd: Option<f64>,
    dry_run: bool,
) -> RepoRunResult {
    if !workspace.exists() {
        return err_result(
            "error",
            "The chosen workspace folder no longer exists — pick it again.".into(),
            None,
        );
    }

    let mut cmd = Command::new(if cfg!(windows) { "npx.cmd" } else { "npx" });
    cmd.arg("-y")
        .arg("@kairose-master/foreman@latest")
        .arg("work")
        .arg("--json")
        .arg("--workspace")
        .arg(workspace);
    if dry_run {
        cmd.arg("--dry-run");
    }
    if let Some(min) = min_bounty_usd {
        if min > 0.0 {
            cmd.arg("--min-bounty").arg(min.to_string());
        }
    }

    // Credentials go through the environment: argv is world-readable in `ps`.
    cmd.env("HANDSEL_URL", platform_url)
        .env("HANDSEL_AGENT_ID", agent_id)
        .env("HANDSEL_WORKER_SECRET", secret)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let out = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            return err_result(
                "error",
                "Could not start Foreman (npx). Is Node.js installed and on PATH?".into(),
                Some(e.to_string()),
            )
        }
    };

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    let payload = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .or_else(|| serde_json::from_str::<serde_json::Value>(stdout.trim()).ok());

    let Some(v) = payload else {
        return err_result(
            "error",
            "Foreman ran but returned no readable result.".into(),
            Some(if stderr.trim().is_empty() {
                stdout.chars().take(600).collect()
            } else {
                stderr.chars().take(600).collect()
            }),
        );
    };

    let job = v.get("job");
    RepoRunResult {
        status: v
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown")
            .to_string(),
        job_id: job
            .and_then(|j| j.get("id"))
            .and_then(|s| s.as_str())
            .map(str::to_string),
        repo: job
            .and_then(|j| j.get("repo"))
            .and_then(|r| r.get("fullName"))
            .and_then(|s| s.as_str())
            .map(str::to_string),
        bounty_usd: job.and_then(|j| j.get("rewardUsd")).and_then(|n| n.as_f64()),
        cost_usd: v.get("costUsd").and_then(|n| n.as_f64()),
        verdict: v
            .get("verdict")
            .and_then(|g| g.get("passed"))
            .map(|p| match p.as_bool() {
                Some(true) => "passed".to_string(),
                Some(false) => "failed".to_string(),
                None => "awaiting review".to_string(),
            }),
        note: v.get("note").and_then(|s| s.as_str()).map(str::to_string),
        error: if out.status.success() || !stderr.trim().is_empty() {
            (!stderr.trim().is_empty()).then(|| stderr.chars().take(600).collect())
        } else {
            None
        },
    }
}
