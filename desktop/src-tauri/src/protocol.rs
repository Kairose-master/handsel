//! The exact 3-call Handsel worker protocol, ported from
//! `public/handsel-worker.mjs` (the reference Node implementation) so
//! this native GUI does the same thing that script does, just without a
//! terminal. See docs/agent-integration.md §2 for the spec these calls
//! implement — this file is not a new protocol, only a new client for the
//! existing one.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

const SYSTEM_PROMPT: &str = "You are an autonomous worker agent on the Handsel labor market. \
Complete the task exactly as specified; be factual and concise, and if code is required give the \
complete, runnable code in a fenced block. Some jobs are one piece of a larger collaboration — when \
these cues appear in the task, follow them: \
(1) If the task shows a collaboration plan and names your piece, deliver ONLY that piece so it slots \
into the plan — do not redo the other pieces. \
(2) If the task provides 'Inputs from upstream work', build directly on them (extend or integrate); \
never restate or redo that upstream work. \
(3) If the task asks you to REVIEW another worker's deliverable, judge it against the criteria and \
begin your reply with a single word — APPROVE or REVISE — then one line explaining why. \
(4) If the task asks you to assemble or synthesize parts, weave them into ONE coherent deliverable, \
not a list of separate sections.";

fn client() -> reqwest::Client {
    // No fixed timeout: a cold local model can take minutes to load on
    // first request (see warmup_model below), and legitimate generations
    // for a long task can run long too. The mining loop itself is what a
    // user cancels from the UI, not a request deadline.
    reqwest::Client::builder()
        .build()
        .expect("reqwest client")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The whole point of the Miner is autonomous mining — without this the
    /// platform never auto-claims open jobs for the agent and the poll loop
    /// sits idle forever (a fresh agent only receives explicitly-dispatched
    /// tasks otherwise).
    pub auto_mine: bool,
    /// Deliverable kinds this worker can produce. The Miner runs chat
    /// models, so it's text-only — the platform then never routes it an
    /// image job it can't do.
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterResponse {
    pub user_id: String,
    pub agent_id: String,
    pub secret: String,
    pub platform_url: String,
    pub smart_account_address: Option<String>,
    pub docs: Option<String>,
}

/// POST /api/agents/register — the headless equivalent of sign-up → create
/// agent → provision on-chain account → "Connect a local worker", in one
/// call. See docs/agent-integration.md §2.
pub async fn register(platform_url: &str, req: &RegisterRequest) -> Result<RegisterResponse, String> {
    let url = format!("{}/api/agents/register", platform_url.trim_end_matches('/'));
    let res = client()
        .post(&url)
        .json(req)
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    let status = res.status();
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("registration returned an unreadable response: {e}"))?;

    if !status.is_success() {
        let msg = body.get("error").and_then(|v| v.as_str()).unwrap_or("registration failed");
        return Err(msg.to_string());
    }

    serde_json::from_value(body).map_err(|e| format!("unexpected registration response shape: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolledTask {
    pub task_id: String,
    pub agent_id: String,
    pub task: String,
    /// What this task expects delivered: "text" (default), "image", … —
    /// non-text kinds are only routed here if this agent declared the
    /// capability, so an image task always means image mining is on.
    #[serde(default = "default_kind")]
    pub deliverable_kind: String,
}

fn default_kind() -> String {
    "text".into()
}

/// POST /api/worker/poll — returns Ok(None) when nothing is queued.
pub async fn poll(platform_url: &str, agent_id: &str, secret: &str) -> Result<Option<PolledTask>, String> {
    let url = format!("{}/api/worker/poll", platform_url.trim_end_matches('/'));
    let res = client()
        .post(&url)
        .header("X-Runtime-Secret", secret)
        .json(&json!({ "agent_id": agent_id }))
        .send()
        .await
        .map_err(|e| format!("poll failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("poll responded {status}: {}", body.chars().take(300).collect::<String>()));
    }

    let body: serde_json::Value = res.json().await.map_err(|e| format!("poll returned unreadable JSON: {e}"))?;
    match body.get("task") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(task) => serde_json::from_value(task.clone())
            .map(Some)
            .map_err(|e| format!("unexpected task shape: {e}")),
    }
}

/// One binary deliverable riding alongside the text output (base64 inline,
/// ≤2MB decoded — matches the platform's inline artifact cap).
#[derive(Debug, Clone, Serialize)]
pub struct Artifact {
    pub name: String,
    pub mime: String,
    pub data_base64: String,
}

/// POST /api/runtime/callback — submits the task's result. `quality_score`
/// is always null by design: self-scoring carries no weight in the credit
/// calculation, only independent grading does (see docs/agent-integration.md).
pub async fn submit_result(
    platform_url: &str,
    agent_id: &str,
    secret: &str,
    task_id: &str,
    success: bool,
    output: &str,
    execution_time_secs: u64,
    artifacts: &[Artifact],
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/runtime/callback", platform_url.trim_end_matches('/'));
    let res = client()
        .post(&url)
        .header("X-Runtime-Secret", secret)
        .json(&json!({
            "task_id": task_id,
            "agent_id": agent_id,
            "success": success,
            "output": output,
            "artifacts": artifacts,
            "quality_score": serde_json::Value::Null,
            "execution_time": execution_time_secs,
            "token_cost": 0,
            "events": [],
        }))
        .send()
        .await
        .map_err(|e| format!("submitting result failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("callback responded {status}: {}", body.chars().take(300).collect::<String>()));
    }
    // Return the parsed body so the caller can surface the grading verdict
    // (paid / refunded / manual review) — the callback grades synchronously.
    let body = res.text().await.unwrap_or_default();
    Ok(serde_json::from_str(&body).unwrap_or(serde_json::Value::Null))
}

/// Where the model call itself goes — either a local Ollama daemon, or any
/// OpenAI-compatible /chat/completions endpoint (LM Studio, vLLM, or a
/// cloud host like Groq/Together/OpenRouter the user already has a free
/// key for). Mirrors --ollama / --openai in handsel-worker.mjs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelBackend {
    Ollama { base_url: String, model: String },
    OpenAiCompatible { base_url: String, api_key: String, model: String },
}

impl ModelBackend {
    pub fn label(&self) -> String {
        match self {
            ModelBackend::Ollama { base_url, model } => format!("{model} via Ollama ({base_url})"),
            ModelBackend::OpenAiCompatible { base_url, model, .. } => format!("{model} via {base_url}"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: Option<OllamaMessage>,
}

#[derive(Debug, Deserialize)]
struct OllamaMessage {
    content: Option<String>,
    thinking: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    content: Option<String>,
    reasoning_content: Option<String>,
}

/// Reasoning models sometimes wrap everything in <think>...</think> and
/// leave the visible answer empty, or stream their reasoning into a
/// separate channel entirely. Prefer the cleaned visible content; fall
/// back to the raw reasoning trace rather than submitting nothing.
fn finish_output(content: &str, thinking: &str) -> String {
    // Only strip COMPLETE <think>...</think> pairs, same as the JS regex
    // this ports (/<think>[\s\S]*?<\/think>/g) — an unclosed tag (truncated
    // output) is left in place rather than silently dropped.
    let mut cleaned = String::new();
    let mut rest = content;
    loop {
        match rest.find("<think>").and_then(|start| rest[start..].find("</think>").map(|end| (start, end))) {
            Some((start, end)) => {
                cleaned.push_str(&rest[..start]);
                rest = &rest[start + end + "</think>".len()..];
            }
            None => {
                cleaned.push_str(rest);
                break;
            }
        }
    }
    let cleaned = cleaned.trim();
    if !cleaned.is_empty() {
        return cleaned.to_string();
    }
    if !content.trim().is_empty() {
        return content.trim().to_string();
    }
    thinking.trim().to_string()
}

async fn ask_ollama(base_url: &str, model: &str, task: &str) -> Result<String, String> {
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));

    // Thinking models (deepseek-r1, qwen3, glm-*) can 500 with a
    // "peg-native format" / parse error: the model generates fine on the GPU,
    // but Ollama's reasoning/tool parser rejects the raw output on some
    // versions. It's intermittent, so retry — and once we've seen a parse
    // crash, disable thinking (`think: false`) to bypass that parser path
    // entirely (we only need the answer text, never the <think> trace).
    let mut disable_think = false;
    let mut last_err = String::new();
    for attempt in 0..3u32 {
        let mut payload = json!({
            "model": model,
            "stream": false,
            "messages": [
                { "role": "system", "content": SYSTEM_PROMPT },
                { "role": "user", "content": task },
            ],
        });
        if disable_think {
            payload["think"] = json!(false);
        }

        let res = client()
            .post(&url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("could not reach Ollama at {base_url}: {e}"))?;

        if res.status().is_success() {
            let parsed: OllamaChatResponse =
                res.json().await.map_err(|e| format!("unexpected Ollama response: {e}"))?;
            let msg = parsed.message.unwrap_or(OllamaMessage { content: None, thinking: None });
            return Ok(finish_output(
                &msg.content.unwrap_or_default(),
                &msg.thinking.unwrap_or_default(),
            ));
        }

        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let body_low = body.to_lowercase();
        last_err = format!(
            "Ollama responded {status}: {} — is `ollama serve` running, and is `{model}` pulled?",
            body.chars().take(300).collect::<String>()
        );

        // Only retry on the known-intermittent server-side parse crash;
        // a 404 (model not pulled) or 400 (bad request) won't fix itself.
        let is_parse_crash = status.is_server_error()
            && (body_low.contains("peg") || body_low.contains("format") || body_low.contains("parse"));
        if !is_parse_crash || attempt == 2 {
            break;
        }
        // Next attempt bypasses the crashing reasoning parser.
        disable_think = true;
    }
    Err(last_err)
}

async fn ask_openai_compatible(base_url: &str, api_key: &str, model: &str, task: &str) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let key = if api_key.trim().is_empty() { "not-needed" } else { api_key.trim() };
    let res = client()
        .post(&url)
        .bearer_auth(key)
        .json(&json!({
            "model": model,
            "stream": false,
            "messages": [
                { "role": "system", "content": SYSTEM_PROMPT },
                { "role": "user", "content": task },
            ],
        }))
        .send()
        .await
        .map_err(|e| format!("could not reach {base_url}: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "model endpoint responded {status}: {}",
            body.chars().take(300).collect::<String>()
        ));
    }

    let parsed: OpenAiChatResponse = res.json().await.map_err(|e| format!("unexpected model response: {e}"))?;
    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "model endpoint returned no choices".to_string())?;
    Ok(finish_output(
        &choice.message.content.unwrap_or_default(),
        &choice.message.reasoning_content.unwrap_or_default(),
    ))
}

pub async fn ask_model(backend: &ModelBackend, task: &str) -> Result<String, String> {
    match backend {
        ModelBackend::Ollama { base_url, model } => ask_ollama(base_url, model, task).await,
        ModelBackend::OpenAiCompatible { base_url, api_key, model } => {
            ask_openai_compatible(base_url, api_key, model, task).await
        }
    }
}

/// A cold local model can take a while to load into memory on its first
/// request. Block here with backoff, retrying a trivial prompt, so mining
/// never claims a task while the model is still warming up — matches
/// warmupModel() in handsel-worker.mjs.
pub async fn warmup_model(backend: &ModelBackend, mut on_attempt: impl FnMut(u32, &str)) -> Result<(), String> {
    const MAX_ATTEMPTS: u32 = 8;
    for attempt in 1..=MAX_ATTEMPTS {
        match ask_model(backend, "Reply with one word: ready").await {
            Ok(_) => return Ok(()),
            Err(e) => {
                on_attempt(attempt, &e);
                if attempt == MAX_ATTEMPTS {
                    return Err(e);
                }
                let backoff_ms = (3000u64 * attempt as u64).min(20_000);
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            }
        }
    }
    unreachable!()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletInfo {
    pub address: Option<String>,
    pub usdc: Option<f64>,
    #[serde(default)]
    pub spent24h: f64,
    pub policy: Option<WalletPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletPolicy {
    #[serde(rename = "maxPerTx")]
    pub max_per_tx: f64,
    #[serde(rename = "dailyCap")]
    pub daily_cap: f64,
}

/// POST /api/worker/wallet — read-only earnings/balance view, same
/// per-agent secret the poll loop uses. Read-only by design: the secret
/// authorizes doing work, not moving money.
pub async fn wallet_info(platform_url: &str, agent_id: &str, secret: &str) -> Result<WalletInfo, String> {
    let url = format!("{}/api/worker/wallet", platform_url.trim_end_matches('/'));
    let res = client()
        .post(&url)
        .header("X-Runtime-Secret", secret)
        .json(&json!({ "agent_id": agent_id }))
        .send()
        .await
        .map_err(|e| format!("wallet lookup failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("wallet lookup responded {status}: {}", body.chars().take(300).collect::<String>()));
    }
    res.json().await.map_err(|e| format!("unexpected wallet response: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithdrawResult {
    pub to: String,
    pub total_sent: f64,
    pub results: Vec<WithdrawAgentResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithdrawAgentResult {
    pub name: String,
    pub sent: f64,
    pub error: Option<String>,
}

/// POST /api/wallet/withdraw — sweeps earnings to `to` (e.g. a MetaMask
/// address). Requires the account PASSWORD, deliberately not the worker
/// secret: money movement re-authenticates as the human owner. The
/// password goes only to the platform (same call the login form makes)
/// and is never stored by this app.
pub async fn withdraw(
    platform_url: &str,
    email: &str,
    password: &str,
    to: &str,
    agent_id: Option<&str>,
) -> Result<WithdrawResult, String> {
    let url = format!("{}/api/wallet/withdraw", platform_url.trim_end_matches('/'));
    let mut body = json!({ "email": email, "password": password, "to": to });
    if let Some(id) = agent_id {
        body["agent_id"] = json!(id);
    }
    let res = client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("withdraw failed: {e}"))?;

    let status = res.status();
    let parsed: serde_json::Value = res.json().await.map_err(|e| format!("unexpected withdraw response: {e}"))?;
    if !status.is_success() {
        let msg = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("withdraw failed");
        return Err(msg.to_string());
    }
    serde_json::from_value(parsed).map_err(|e| format!("unexpected withdraw response shape: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCardStats {
    pub name: String,
    pub credit_score: i64,
    pub credit_rating: String,
}

/// GET /api/agents/:id/card — the agent's public ERC-8004-style card.
/// No auth (registration files are the standard's discovery layer); we
/// surface the Handsel underwriting extensions the Miner cares about.
pub async fn agent_card(platform_url: &str, agent_id: &str) -> Result<AgentCardStats, String> {
    let url = format!("{}/api/agents/{}/card", platform_url.trim_end_matches('/'), agent_id);
    let res = client().get(&url).send().await.map_err(|e| format!("card lookup failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("card lookup responded {}", res.status()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| format!("unexpected card response: {e}"))?;
    Ok(AgentCardStats {
        name: body.get("name").and_then(|v| v.as_str()).unwrap_or("Agent").to_string(),
        credit_score: body
            .pointer("/handsel/creditScore")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        credit_rating: body
            .pointer("/handsel/creditRating")
            .and_then(|v| v.as_str())
            .unwrap_or("unrated")
            .to_string(),
    })
}

/// Shared POST /api/delegations caller — the response is passed to the
/// frontend as raw JSON (serde_json::Value): the UI renders whatever the
/// platform returns, so new fields don't require a Rust release.
async fn delegations_call(
    platform_url: &str,
    body: serde_json::Value,
    secret: Option<&str>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/delegations", platform_url.trim_end_matches('/'));
    let mut req = client().post(&url).json(&body);
    if let Some(s) = secret {
        req = req.header("X-Runtime-Secret", s);
    }
    let res = req.send().await.map_err(|e| format!("delegation call failed: {e}"))?;
    let status = res.status();
    let parsed: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("unexpected delegation response: {e}"))?;
    if !status.is_success() {
        let msg = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("delegation call failed");
        return Err(msg.to_string());
    }
    Ok(parsed)
}

/// op "plan" — decompose a goal into priced subtasks. Nothing is escrowed
/// yet; requires the account password (owner action, and the planner LLM
/// costs tokens). Never stores the password.
pub async fn delegation_plan(
    platform_url: &str,
    email: &str,
    password: &str,
    prime_agent_id: &str,
    goal: &str,
    budget_usd: f64,
) -> Result<serde_json::Value, String> {
    delegations_call(
        platform_url,
        json!({
            "op": "plan",
            "email": email,
            "password": password,
            "prime_agent_id": prime_agent_id,
            "goal": goal,
            "budget_usd": budget_usd,
            "auto_verify": true,
        }),
        None,
    )
    .await
}

/// op "confirm" — the moment money moves (per-subtask escrow from the
/// prime agent's wallet). Password again: same rule as withdraw.
pub async fn delegation_confirm(
    platform_url: &str,
    email: &str,
    password: &str,
    id: &str,
) -> Result<serde_json::Value, String> {
    delegations_call(
        platform_url,
        json!({ "op": "confirm", "email": email, "password": password, "id": id }),
        None,
    )
    .await
}

/// op "discard" — drop an unconfirmed plan (nothing was escrowed).
pub async fn delegation_discard(
    platform_url: &str,
    email: &str,
    password: &str,
    id: &str,
) -> Result<serde_json::Value, String> {
    delegations_call(
        platform_url,
        json!({ "op": "discard", "email": email, "password": password, "id": id }),
        None,
    )
    .await
}

/// op "status" — worker-secret-authenticated read of the owner's
/// delegations; each poll also drives the platform's verification tick
/// (the same no-cron heartbeat the web page's polling provides).
pub async fn delegation_status(
    platform_url: &str,
    agent_id: &str,
    secret: &str,
) -> Result<serde_json::Value, String> {
    delegations_call(platform_url, json!({ "op": "status", "agent_id": agent_id }), Some(secret)).await
}

/// POST /api/worker/governance — the Miner's $LEDGER governance panel.
/// Worker-secret auth (safe: the worst it can do is vote/lock EARNED
/// $LEDGER, which never leaves the platform — money still needs the
/// password). Raw JSON in/out so new fields don't need a Rust release.
pub async fn governance(
    platform_url: &str,
    agent_id: &str,
    secret: &str,
    action: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/worker/governance", platform_url.trim_end_matches('/'));
    let mut body = args;
    if let Some(map) = body.as_object_mut() {
        map.insert("agent_id".into(), json!(agent_id));
        map.insert("action".into(), json!(action));
    }
    let res = client()
        .post(&url)
        .header("X-Runtime-Secret", secret)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("governance call failed: {e}"))?;
    let status = res.status();
    let parsed: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("unexpected governance response: {e}"))?;
    if !status.is_success() {
        let msg = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("governance call failed");
        return Err(msg.to_string());
    }
    Ok(parsed)
}

/// POST /api/worker/capabilities — declare what work this agent can be
/// matched to (worker-secret auth; no money involved). Used by the image
/// mining toggle.
pub async fn update_capabilities(
    platform_url: &str,
    agent_id: &str,
    secret: &str,
    capabilities: &[&str],
) -> Result<Vec<String>, String> {
    let url = format!("{}/api/worker/capabilities", platform_url.trim_end_matches('/'));
    let res = client()
        .post(&url)
        .header("X-Runtime-Secret", secret)
        .json(&json!({ "agent_id": agent_id, "capabilities": capabilities }))
        .send()
        .await
        .map_err(|e| format!("capability update failed: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| format!("unexpected response: {e}"))?;
    if !status.is_success() {
        return Err(body.get("error").and_then(|v| v.as_str()).unwrap_or("capability update failed").to_string());
    }
    Ok(body
        .get("capabilities")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default())
}

const IMAGE_API: &str = "https://image.pollinations.ai/prompt/";

/// Generate an image for an image-deliverable task via the free, keyless
/// pollinations.ai API — the same backend the SDK's image-worker example
/// uses. Returns (mime, base64). The task text is squeezed into a compact
/// visual prompt; the platform's independent reviewer judges the result.
/// List the image models the keyless generation API offers, so the setup
/// screen can present a picker instead of a hidden hardcoded default.
pub async fn list_image_models() -> Result<Vec<String>, String> {
    let res = client()
        .get("https://image.pollinations.ai/models")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("couldn't reach image model list: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("image model list responded {}", res.status()));
    }
    let models: Vec<String> = res
        .json()
        .await
        .map_err(|e| format!("unexpected image model list: {e}"))?;
    Ok(models)
}

pub async fn generate_image(task: &str, model: Option<&str>) -> Result<(String, String), String> {
    let prompt: String = task
        .replace("Acceptance criteria (what \"done\" means):", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect();
    // 1024×1024: image jobs commonly require ≥1024px, and a 768px render
    // fails that acceptance check outright (independent of visual quality).
    let model_q = match model {
        Some(m) if !m.is_empty() => format!("&model={}", urlencoding_encode(m)),
        _ => String::new(),
    };
    let url = format!(
        "{IMAGE_API}{}?width=1024&height=1024&nologo=true{model_q}",
        urlencoding_encode(&prompt)
    );

    // pollinations intermittently returns a tiny error body (a few hundred
    // bytes of HTML/JSON) instead of a real image — under load, rate limits,
    // or a transient upstream error. Submitting THAT is what produced the
    // 441-byte "images" the grader (correctly) rejected. Retry, and never
    // return a body that isn't a real, non-trivial image.
    let mut last_err = String::new();
    for attempt in 0..3u32 {
        let res = match client().get(&url).timeout(Duration::from_secs(180)).send().await {
            Ok(r) => r,
            Err(e) => { last_err = format!("image API unreachable: {e}"); continue }
        };
        if !res.status().is_success() {
            last_err = format!("image API responded {}", res.status());
            tokio::time::sleep(Duration::from_secs(2 * (attempt as u64 + 1))).await;
            continue;
        }
        let mime = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .split(';')
            .next()
            .unwrap_or("image/jpeg")
            .to_string();
        let bytes = match res.bytes().await {
            Ok(b) => b,
            Err(e) => { last_err = format!("image download failed: {e}"); continue }
        };
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("generated image exceeds the 2MB inline artifact cap".into());
        }
        // Validate: real content-type + plausible size + image magic bytes.
        // A sub-2KB "image" or a non-image body is a failed generation — retry
        // rather than submit garbage that will just fail grading.
        let looks_image = mime.starts_with("image/") && is_image_magic(&bytes);
        if looks_image && bytes.len() >= 2000 {
            return Ok((mime, base64_encode(&bytes)));
        }
        last_err = format!(
            "image API returned a non-image / broken body ({} bytes, type {mime}) — retrying",
            bytes.len()
        );
        tokio::time::sleep(Duration::from_secs(2 * (attempt as u64 + 1))).await;
    }
    Err(format!("could not get a valid image after 3 tries: {last_err}"))
}

/// True if the bytes start with a known image signature (PNG, JPEG, GIF, WEBP).
fn is_image_magic(b: &[u8]) -> bool {
    b.len() > 12
        && (b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) // PNG
            || b.starts_with(&[0xFF, 0xD8, 0xFF]) // JPEG
            || b.starts_with(b"GIF8") // GIF
            || (&b[0..4] == b"RIFF" && &b[8..12] == b"WEBP")) // WEBP
}

const TTS_API: &str = "https://translate.google.com/translate_tts";

/// Turn a task into narration audio (real, keyless). Derives a script from
/// the task text, chunks it to the TTS endpoint's ~200-char limit, and
/// concatenates the MP3 frames — the audio lane's genuine deliverable.
pub async fn generate_audio(task: &str, voice: Option<&str>) -> Result<(String, String), String> {
    let tl = match voice {
        Some(v) if !v.is_empty() => v,
        _ => "en",
    };
    // Prefer an explicit script marker: audio jobs put the exact line to
    // speak after `Script to read:` (often quoted). Reading only that keeps
    // the deliverable clean and matches what the grader transcribes against.
    // Fall back to the pre-criteria task text for free-form narration asks.
    let raw = task.split("Acceptance criteria").next().unwrap_or(task);
    let after_marker = raw
        .split_once("Script to read:")
        .map(|(_, rest)| rest)
        .unwrap_or(raw)
        .trim()
        .trim_matches(|c| c == '"' || c == '\u{201C}' || c == '\u{201D}' || c == '\'');
    let script: String = after_marker
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(600) // a few chunks — enough for a narration deliverable
        .collect();
    if script.trim().is_empty() {
        return Err("no narratable text in the task".into());
    }

    // Split into <=180-char chunks on word boundaries (TTS caps each request).
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for word in script.split_whitespace() {
        if cur.len() + word.len() + 1 > 180 && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }

    let mut audio: Vec<u8> = Vec::new();
    for (i, chunk) in chunks.iter().take(6).enumerate() {
        let url = format!(
            "{TTS_API}?ie=UTF-8&tl={tl}&client=tw-ob&idx={i}&q={}",
            urlencoding_encode(chunk)
        );
        let res = client()
            .get(&url)
            .header("User-Agent", "Mozilla/5.0")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("TTS unreachable: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("TTS responded {}", res.status()));
        }
        let bytes = res.bytes().await.map_err(|e| format!("TTS download failed: {e}"))?;
        audio.extend_from_slice(&bytes);
        if audio.len() > 3 * 1024 * 1024 {
            break; // stay under the inline-artifact cap
        }
    }
    if audio.is_empty() {
        return Err("TTS produced no audio".into());
    }
    Ok(("audio/mpeg".to_string(), base64_encode(&audio)))
}

/// Minimal percent-encoding for a URL path segment (no extra crates).
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Minimal base64 (standard alphabet, padded) — avoids pulling a crate for
/// one encode call.
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Ollama's own local listing endpoint — used to auto-detect whether the
/// user already has Ollama running, and which models are pulled, before
/// asking them to configure anything by hand.
pub async fn detect_ollama_models(base_url: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let res = client()
        .get(&url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| "Ollama is not running on this machine".to_string())?;

    if !res.status().is_success() {
        return Err("Ollama responded with an error".to_string());
    }

    #[derive(Deserialize)]
    struct Tags {
        models: Vec<TagModel>,
    }
    #[derive(Deserialize)]
    struct TagModel {
        name: String,
    }

    let tags: Tags = res.json().await.map_err(|e| format!("unexpected Ollama response: {e}"))?;
    Ok(tags.models.into_iter().map(|m| m.name).collect())
}

/// A model offered by an OpenAI-compatible provider, with the metadata the
/// picker needs to help a user choose the RIGHT one — context window and,
/// crucially, whether it can see images, so image jobs go to a vision model
/// instead of a text-only one that would only emit ASCII/code and fail
/// grading.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: Option<String>,
    pub context: Option<u64>,
    pub vision: bool,
}

/// List models from any OpenAI-compatible `{base}/models` endpoint. Keyless
/// where the provider allows it (OpenRouter), Bearer-authed otherwise (Groq,
/// Hugging Face). OpenRouter returns rich metadata (context length + input
/// modalities) which we surface; plainer providers return ids only — still
/// enough to pick from a searchable list instead of typing an id by hand.
pub async fn list_openai_models(base_url: &str, api_key: &str) -> Result<Vec<ModelInfo>, String> {
    let base = base_url.trim_end_matches('/');
    if base.is_empty() {
        return Err("Enter the API base URL first (or pick a provider chip).".to_string());
    }
    let url = format!("{base}/models");
    let mut req = client().get(&url).timeout(Duration::from_secs(15));
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {url}: {e}"))?;
    if !res.status().is_success() {
        let code = res.status().as_u16();
        return Err(match code {
            401 | 403 => "The API key was rejected — check the key for this provider.".to_string(),
            404 => format!("No /models endpoint at {base} — is the base URL right?"),
            _ => format!("Provider returned HTTP {code} for {url}"),
        });
    }

    #[derive(Deserialize)]
    struct ModelsResp {
        data: Vec<RawModel>,
    }
    #[derive(Deserialize)]
    struct RawModel {
        id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        context_length: Option<u64>,
        #[serde(default)]
        architecture: Option<Arch>,
    }
    #[derive(Deserialize)]
    struct Arch {
        #[serde(default)]
        modality: Option<String>,
        #[serde(default)]
        input_modalities: Option<Vec<String>>,
    }

    let parsed: ModelsResp = res
        .json()
        .await
        .map_err(|e| format!("unexpected /models response: {e}"))?;
    let mut out: Vec<ModelInfo> = parsed
        .data
        .into_iter()
        .map(|m| {
            let vision = m
                .architecture
                .as_ref()
                .map(|a| {
                    a.input_modalities
                        .as_ref()
                        .map(|v| v.iter().any(|s| s == "image"))
                        .unwrap_or(false)
                        || a.modality.as_ref().map(|s| s.contains("image")).unwrap_or(false)
                })
                .unwrap_or(false);
            ModelInfo { id: m.id, name: m.name, context: m.context_length, vision }
        })
        .collect();
    out.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    Ok(out)
}
