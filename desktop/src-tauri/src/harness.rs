//! The harness lane: hand a claimed task to a real coding agent.
//!
//! The Miner's own lanes are one prompt in, one artifact out. A real
//! engineering task is not that shape, and the Node worker already solved
//! this by delegating to an installed coding harness (Claude Code, Codex,
//! OpenCode, Cline, Gemini CLI) — see `lib/worker-harness.ts` and
//! `docs/coding-harness.md`. This module is that adapter registry in Rust,
//! MIRRORED, not reinvented: the argv per tool, the deliverable-file
//! contract, and the autodetect order must match the Node side, and
//! `tests/desktop-harness-mirror.test.ts` pins this file against
//! `lib/worker-harness.ts` so a drifting mirror fails the build.
//!
//! Two contracts inherited from the Node side, with their reasons:
//!
//!  - **The deliverable comes from a file, not stdout.** Every harness has a
//!    different, unversioned `--json` stream; a schema change would make the
//!    Miner silently submit an empty deliverable. The brief tells the
//!    harness to write `.handsel/deliverable-<task>.md`; that file is read
//!    back and submitted. Stdout survives only as a tolerant fallback.
//!  - **Every adapter passes its auto-approval flag.** A headless run that
//!    stops to ask never answers, and the escrow expires. Which makes this
//!    lane strictly MORE permissive than the chat lanes — the workdir picker
//!    is the consent boundary, exactly like the repo lane's workspace.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

/// Not a quality ranking: tools whose headless contract is most explicitly
/// specified come first, because a wrong pick costs a real bounty.
/// Mirror of `AUTODETECT_ORDER` in lib/worker-harness.ts.
pub const AUTODETECT_ORDER: [&str; 5] = ["claude", "codex", "opencode", "cline", "gemini"];

/// Where a harness is told to leave its finished work, relative to the
/// workdir. Per task, never one shared name — with concurrency, a leftover
/// file from an interrupted task would be submitted to the NEXT client as
/// their deliverable. The id is sanitised because it names a file on the
/// owner's disk. Mirror of `deliverablePathFor`.
pub fn deliverable_rel_path(task_id: &str) -> String {
    let safe: String = task_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    let safe = if safe.is_empty() { "task".to_string() } else { safe };
    format!(".handsel/deliverable-{safe}.md")
}

/// The instruction appended to every brief. Mirror of
/// `deliverableInstruction` — the whole file-handoff contract lives in these
/// words, so they must say what happens rather than merely ask.
pub fn harness_brief(brief: &str, rel_path: &str) -> String {
    format!(
        "{brief}\n\n---\n\nHOW THIS IS SUBMITTED:\n\
         When you are finished, write your complete deliverable to `{rel_path}` (create the directory if needed).\n\
         That file is what gets submitted to the client and graded — nothing else you print is read.\n\
         If the task was to change code, the file should describe what you changed and why; the changed files themselves stay where you wrote them.\n\
         Write it as the last thing you do, once the work is actually done."
    )
}

/// Everything after the binary. Mirror of the `HARNESSES` registry: long
/// flags only (these tools agree on nothing, including which letter -c is),
/// no `--add-dir` for claude (variadic — it eats the brief), and the
/// workdir always doubles as the child's cwd.
pub fn argv_for(bin: &str, workdir: &Path, brief: &str) -> Option<Vec<String>> {
    let w = workdir.display().to_string();
    let b = brief.to_string();
    Some(match bin {
        "claude" => vec![
            "--print".into(),
            "--permission-mode".into(),
            "bypassPermissions".into(),
            b,
        ],
        "codex" => vec![
            "exec".into(),
            "--cd".into(),
            w,
            "--full-auto".into(),
            "--skip-git-repo-check".into(),
            b,
        ],
        "opencode" => vec!["run".into(), "--dir".into(), w, "--auto".into(), b],
        "cline" => vec!["--yolo".into(), "--cwd".into(), w, b],
        "gemini" => vec!["--yolo".into(), "--prompt".into(), b],
        _ => return None,
    })
}

/// Find `bin` on PATH (with the Windows launcher suffixes npm globals use).
fn find_on_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) { &["", ".cmd", ".exe", ".bat"] } else { &[""] };
    for dir in std::env::split_paths(&path) {
        for ext in exts {
            let candidate = dir.join(format!("{bin}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The installed subset of the registry, in autodetect order.
pub fn detect_installed() -> Vec<String> {
    AUTODETECT_ORDER
        .iter()
        .filter(|b| find_on_path(b).is_some())
        .map(|b| b.to_string())
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessStatus {
    /// Installed harness binaries, autodetect order.
    pub installed: Vec<String>,
    /// The one this run would use: the configured pick, else the first found.
    pub chosen: Option<String>,
    pub workdir: Option<String>,
    pub enabled: bool,
    pub ready: bool,
    /// One sentence naming the single next thing to fix, or why it is ready.
    pub detail: String,
}

pub fn status(
    enabled: bool,
    configured_bin: Option<&str>,
    workdir: Option<&str>,
) -> HarnessStatus {
    let installed = detect_installed();
    let chosen = configured_bin
        .filter(|b| installed.iter().any(|i| i == b))
        .map(str::to_string)
        .or_else(|| installed.first().cloned());
    let workdir_ok = workdir.map(|w| Path::new(w).exists()).unwrap_or(false);

    let detail = if installed.is_empty() {
        "No coding harness found on PATH. Install one (e.g. `npm i -g @anthropic-ai/claude-code`) and reopen this tab.".to_string()
    } else if !workdir_ok {
        "Choose a scratch folder. The harness can edit and run anything inside it, so pick a throwaway checkout — never your home directory, never anything holding credentials.".to_string()
    } else if !enabled {
        "Ready — turn the toggle on and text jobs are handed to the harness with real file access in your scratch folder.".to_string()
    } else {
        "On. Claimed text jobs are handed to the harness; whatever it writes to its deliverable file is submitted and graded.".to_string()
    };

    HarnessStatus {
        ready: !installed.is_empty() && workdir_ok,
        installed,
        chosen,
        workdir: workdir.map(str::to_string),
        enabled,
        detail,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessOutcome {
    pub success: bool,
    /// The deliverable text on success; the failure reason otherwise.
    pub output: String,
    /// Where the deliverable came from — "file" or "stdout" — for the log.
    pub source: String,
}

fn fail(msg: String) -> HarnessOutcome {
    HarnessOutcome { success: false, output: msg, source: "none".into() }
}

/// Run one task through the harness: spawn, wait (bounded), read the
/// deliverable file back, fall back to stdout. The timeout is a hard wall —
/// a hung harness holds a concurrency slot.
pub async fn run_task(
    bin: &str,
    workdir: &Path,
    task_id: &str,
    brief: &str,
    timeout_secs: u64,
) -> HarnessOutcome {
    if !workdir.exists() {
        return fail("The harness scratch folder no longer exists — pick it again.".into());
    }
    let rel = deliverable_rel_path(task_id);
    let deliverable = workdir.join(&rel);
    // A stale file from a crashed earlier attempt of THIS task must not be
    // read back as if the run below produced it.
    let _ = std::fs::remove_file(&deliverable);

    let full_brief = harness_brief(brief, &rel);
    let Some(argv) = argv_for(bin, workdir, &full_brief) else {
        return fail(format!("Unknown harness \"{bin}\"."));
    };
    let Some(resolved) = find_on_path(bin) else {
        return fail(format!("`{bin}` is no longer on PATH."));
    };

    let mut cmd = Command::new(resolved);
    cmd.args(&argv)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let out = match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output()).await {
        Err(_) => return fail(format!("Harness timed out after {timeout_secs}s — the run was killed.")),
        Ok(Err(e)) => return fail(format!("Could not start `{bin}`: {e}")),
        Ok(Ok(o)) => o,
    };

    // File first — the one interface every harness shares.
    if let Ok(text) = std::fs::read_to_string(&deliverable) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return HarnessOutcome { success: true, output: trimmed.to_string(), source: "file".into() };
        }
    }

    // Fallback: tolerant stdout. Approximately right beats empty — an empty
    // submission fails grading with no clue why.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let trimmed = stdout.trim();
    if !trimmed.is_empty() {
        return HarnessOutcome { success: true, output: trimmed.to_string(), source: "stdout".into() };
    }

    let stderr = String::from_utf8_lossy(&out.stderr);
    fail(format!(
        "Harness produced neither a deliverable file nor output (exit {:?}). {}",
        out.status.code(),
        stderr.chars().take(400).collect::<String>()
    ))
}
