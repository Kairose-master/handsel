// Prevents an extra console window from popping up on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod harness;
mod protocol;
mod repo_lane;

use protocol::{ModelBackend, RegisterRequest, RegisterResponse};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

const DEFAULT_PLATFORM_URL: &str = "https://ai-agent-credit-dashboard.vercel.app";
const POLL_INTERVAL_SECS: u64 = 4;
const MINING_CONCURRENCY: u64 = 1;

/// Whether the system tray was successfully created — decides if closing
/// the window hides to tray (true) or actually quits (false).
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AgentConfig {
    platform_url: String,
    agent_id: String,
    secret: String,
    name: String,
    /// Account email, kept for withdrawal (which re-authenticates with the
    /// account password — never stored — rather than the worker secret).
    #[serde(default)]
    email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredConfig {
    agent: Option<AgentConfig>,
    backend: Option<ModelBackend>,
    /// Image mining: when on, this agent declares the 'image' capability
    /// and image-deliverable jobs are fulfilled via the free keyless
    /// generation API instead of the chat model.
    #[serde(default)]
    image_mining: bool,
    /// Which image-generation model to use for image jobs (pollinations model
    /// name, e.g. "flux"). None → the API default.
    #[serde(default)]
    image_model: Option<String>,
    /// Which TTS voice/language to narrate audio jobs in (Google TTS `tl`
    /// code, e.g. "en", "ko"). None → English.
    #[serde(default)]
    audio_voice: Option<String>,
    /// The folder the owner approved for repo-job clones. Absent until they
    /// pick one — this is the repo lane's entire permission boundary, so it
    /// is never defaulted to the cwd or a guessed home directory.
    #[serde(default)]
    repo_workspace: Option<String>,
    /// Harness lane (src/harness.rs): hand text jobs to an installed coding
    /// agent instead of the chat model. Off until the owner both picks a
    /// scratch folder AND flips the toggle — the folder is the permission
    /// boundary, same shape as repo_workspace, and it is never defaulted.
    #[serde(default)]
    harness_enabled: bool,
    #[serde(default)]
    harness_bin: Option<String>,
    #[serde(default)]
    harness_workdir: Option<String>,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve config directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create config directory: {e}"))?;
    Ok(dir.join("config.json"))
}

fn load_stored_config(app: &tauri::AppHandle) -> StoredConfig {
    let Ok(path) = config_path(app) else { return StoredConfig::default() };
    let Ok(raw) = std::fs::read_to_string(path) else { return StoredConfig::default() };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_stored_config(app: &tauri::AppHandle, cfg: &StoredConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| format!("could not save config: {e}"))
}

/// Mining runs as a background tokio task; `mining_flag` is how the UI
/// cancels it (checked between poll cycles — never mid-task, so a task
/// already claimed always gets submitted rather than abandoned).
struct AppState {
    mining_flag: Arc<AtomicBool>,
    is_mining: Mutex<bool>,
    // Poll cadence in seconds — the miner's "reflex speed". The game trains
    // it faster (down to a floor) as 💎 accrue from real completed jobs, so
    // buying reflexes genuinely makes the worker grab real jobs sooner.
    poll_interval: Arc<AtomicU64>,
    // How many jobs to run at once. A single poll driver feeds this many
    // executor slots (see run_mining_loop); polling stays serial so the
    // platform's in-poll on-chain accepts don't collide on this agent's nonce.
    concurrency: Arc<AtomicU64>,
    // A handsel:// deep link's decoded connect payload, held here until the
    // person confirms IN THE APP. Never applied on receipt: any web page can
    // fire a deep link, and silently swapping the configured agent for an
    // attacker's would have this machine mining into someone else's wallet.
    pending_connect: Mutex<Option<AgentConfig>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            mining_flag: Arc::new(AtomicBool::new(false)),
            is_mining: Mutex::new(false),
            poll_interval: Arc::new(AtomicU64::new(POLL_INTERVAL_SECS)),
            concurrency: Arc::new(AtomicU64::new(MINING_CONCURRENCY)),
            pending_connect: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
enum MiningEvent {
    Log { line: String },
    Status { state: String, tasks_completed: u32, tasks_failed: u32 },
}

fn emit_event(app: &tauri::AppHandle, event: MiningEvent) {
    let _ = app.emit("mining-event", event);
}

/// Native OS notification — the window is usually hidden in the tray, so
/// this is how completed work actually reaches the person. Best-effort.
fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---- Commands the frontend calls via invoke() ----

#[tauri::command]
fn default_platform_url() -> String {
    DEFAULT_PLATFORM_URL.to_string()
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> StoredConfig {
    load_stored_config(&app)
}

#[tauri::command]
async fn register_agent(
    app: tauri::AppHandle,
    platform_url: String,
    email: String,
    password: String,
    name: String,
) -> Result<RegisterResponse, String> {
    let platform_url = if platform_url.trim().is_empty() { DEFAULT_PLATFORM_URL.to_string() } else { platform_url };
    let req = RegisterRequest {
        email,
        password,
        name,
        description: Some("Handsel Miner desktop app".into()),
        auto_mine: true,
        capabilities: vec!["text".into()],
    };
    let res = protocol::register(&platform_url, &req).await?;

    let mut cfg = load_stored_config(&app);
    cfg.agent = Some(AgentConfig {
        platform_url: res.platform_url.clone(),
        agent_id: res.agent_id.clone(),
        secret: res.secret.clone(),
        name: req.name.clone(),
        email: req.email.clone(),
    });
    save_stored_config(&app, &cfg)?;
    Ok(res)
}

#[tauri::command]
fn forget_account(app: tauri::AppHandle) -> Result<(), String> {
    let path = config_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("could not clear saved account: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn detect_ollama() -> Result<Vec<String>, String> {
    protocol::detect_ollama_models("http://localhost:11434").await
}

/// List a hosted provider's models (OpenAI-compatible `/models`) so the setup
/// screen can offer a searchable picker with vision/context hints instead of a
/// blank "type the model id" box. Runs in Rust because the webview CSP blocks
/// cross-origin fetches.
#[tauri::command]
async fn list_models(base_url: String, api_key: String) -> Result<Vec<protocol::ModelInfo>, String> {
    protocol::list_openai_models(&base_url, &api_key).await
}

/// The image-generation models the keyless lane can use (pollinations).
#[tauri::command]
async fn list_image_models() -> Result<Vec<String>, String> {
    protocol::list_image_models().await
}

/// Persist which image model / audio voice the generation lanes should use.
/// Empty strings clear back to the API defaults.
#[tauri::command]
fn save_lane_models(
    app: tauri::AppHandle,
    image_model: Option<String>,
    audio_voice: Option<String>,
) -> Result<(), String> {
    let mut cfg = load_stored_config(&app);
    cfg.image_model = image_model.filter(|s| !s.is_empty());
    cfg.audio_voice = audio_voice.filter(|s| !s.is_empty());
    save_stored_config(&app, &cfg)
}

#[tauri::command]
fn save_backend(app: tauri::AppHandle, backend: ModelBackend) -> Result<(), String> {
    let mut cfg = load_stored_config(&app);
    cfg.backend = Some(backend);
    save_stored_config(&app, &cfg)
}

#[tauri::command]
async fn get_wallet(app: tauri::AppHandle) -> Result<protocol::WalletInfo, String> {
    let cfg = load_stored_config(&app);
    let agent = cfg.agent.ok_or_else(|| "No agent registered yet.".to_string())?;
    protocol::wallet_info(&agent.platform_url, &agent.agent_id, &agent.secret).await
}

/// Withdraw earnings to `to` (a MetaMask or any EVM address). `password`
/// is passed straight through to the platform for re-authentication and
/// never touches the config file.
#[tauri::command]
async fn withdraw_earnings(app: tauri::AppHandle, to: String, password: String) -> Result<protocol::WithdrawResult, String> {
    let cfg = load_stored_config(&app);
    let agent = cfg.agent.ok_or_else(|| "No agent registered yet.".to_string())?;
    if agent.email.is_empty() {
        return Err("This install predates withdrawal support — use \"Use a different account\" and reconnect once.".to_string())
    }
    protocol::withdraw(&agent.platform_url, &agent.email, &password, &to, Some(&agent.agent_id)).await
}

/// Toggle image mining: declares/undeclares the 'image' capability on the
/// platform (so the matcher routes/stops routing image jobs here) and
/// persists the choice. Takes effect immediately — the mining loop reads
/// each task's deliverable_kind per poll.
#[tauri::command]
async fn set_image_mining(app: tauri::AppHandle, enabled: bool) -> Result<Vec<String>, String> {
    let mut cfg = load_stored_config(&app);
    let agent = cfg.agent.clone().ok_or_else(|| "No agent registered yet.".to_string())?;
    let caps: Vec<&str> = if enabled { vec!["text", "image"] } else { vec!["text"] };
    let confirmed = protocol::update_capabilities(&agent.platform_url, &agent.agent_id, &agent.secret, &caps).await?;
    cfg.image_mining = enabled;
    save_stored_config(&app, &cfg)?;
    Ok(confirmed)
}

/// Declare which deliverable lanes this miner works. Only lanes the miner can
/// genuinely fulfill (image via generation, audio via TTS) should be enabled
/// — a declared-but-unfulfillable lane just claims-and-fails jobs.
#[tauri::command]
async fn set_lanes(app: tauri::AppHandle, image: bool, audio: bool) -> Result<Vec<String>, String> {
    let mut cfg = load_stored_config(&app);
    let agent = cfg.agent.clone().ok_or_else(|| "No agent registered yet.".to_string())?;
    let mut caps: Vec<&str> = vec!["text"];
    if image { caps.push("image"); }
    if audio { caps.push("audio"); }
    let confirmed = protocol::update_capabilities(&agent.platform_url, &agent.agent_id, &agent.secret, &caps).await?;
    cfg.image_mining = image; // keep the legacy flag in sync for the toggle
    save_stored_config(&app, &cfg)?;
    Ok(confirmed)
}

/// Open a URL in the system browser — used by the "Connect Claude/ChatGPT"
/// section (the connector onboarding lives on the web, where OAuth can run).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https URLs can be opened".into());
    }
    open::that(&url).map_err(|e| format!("could not open browser: {e}"))
}

#[tauri::command]
async fn start_mining(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cfg = load_stored_config(&app);
    let agent = cfg.agent.ok_or_else(|| "No agent registered yet.".to_string())?;
    let backend = cfg.backend.ok_or_else(|| "No model backend configured yet.".to_string())?;

    {
        let mut mining = state.is_mining.lock().await;
        if *mining {
            return Ok(()); // already running — idempotent
        }
        *mining = true;
    }

    state.mining_flag.store(true, Ordering::SeqCst);
    let flag = state.mining_flag.clone();
    // `state: State<'_, AppState>` is borrowed only for this command call —
    // it can't be moved into a spawned task. Hand the task the AppHandle
    // instead (cheaply cloneable) and reach AppState back out via
    // app_handle.state() from inside the task when it needs it.
    let app_handle = app.clone();

    tokio::spawn(async move {
        run_mining_loop(app_handle, agent, backend, flag).await;
    });

    Ok(())
}

#[tauri::command]
async fn stop_mining(state: State<'_, AppState>) -> Result<(), String> {
    state.mining_flag.store(false, Ordering::SeqCst);
    Ok(())
}

/// Set the miner's poll cadence (the game's "reflex speed"). Clamped to a
/// sane range so a maxed reflex tree still can't hammer the platform.
#[tauri::command]
fn set_poll_interval(secs: u64, state: State<'_, AppState>) -> u64 {
    let clamped = secs.clamp(3, 30);
    state.poll_interval.store(clamped, Ordering::Relaxed);
    clamped
}

/// How many jobs the miner runs at once. Bounded [1,4] — the parallelism is in
/// local execution; the platform still accepts jobs serially per agent. Takes
/// effect on the next poll, no restart needed.
#[tauri::command]
fn set_concurrency(slots: u64, state: State<'_, AppState>) -> u64 {
    let clamped = slots.clamp(1, 4);
    state.concurrency.store(clamped, Ordering::Relaxed);
    clamped
}

/// Current concurrency, so the UI can render the right initial value.
#[tauri::command]
fn get_concurrency(state: State<'_, AppState>) -> u64 {
    state.concurrency.load(Ordering::Relaxed)
}

async fn run_mining_loop(app: tauri::AppHandle, agent: AgentConfig, backend: ModelBackend, flag: Arc<AtomicBool>) {
    emit_event(&app, MiningEvent::Log { line: format!("Warming up {}…", backend.label()) });
    emit_event(&app, MiningEvent::Status { state: "warming".into(), tasks_completed: 0, tasks_failed: 0 });

    let warmup = protocol::warmup_model(&backend, |attempt, err| {
        emit_event(
            &app,
            MiningEvent::Log { line: format!("Still warming up (attempt {attempt}/8): {err}") },
        );
    })
    .await;

    if let Err(e) = warmup {
        emit_event(&app, MiningEvent::Log { line: format!("Model never became ready: {e}") });
        emit_event(&app, MiningEvent::Status { state: "error".into(), tasks_completed: 0, tasks_failed: 0 });
        *app.state::<AppState>().is_mining.lock().await = false;
        return;
    }

    emit_event(&app, MiningEvent::Log { line: "Model is warm. Polling for work…".into() });

    let completed = Arc::new(AtomicU32::new(0));
    let failed = Arc::new(AtomicU32::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    // Cheaply cloneable handles for the spawned executors (they outlive this
    // stack frame, so they can't borrow `agent`/`backend`).
    let agent = Arc::new(agent);
    let backend = Arc::new(backend);
    let mut consecutive_errors: u32 = 0;

    // Single poll driver, N executor slots. Polling stays serial so the
    // platform's in-poll on-chain accept (which shares this agent's account
    // nonce) never runs concurrently with itself — the parallelism is in
    // EXECUTING claimed tasks. concurrency == 1 reproduces the old loop.
    while flag.load(Ordering::SeqCst) {
        let slots = app.state::<AppState>().concurrency.load(Ordering::Relaxed).max(1) as usize;
        emit_event(&app, MiningEvent::Status {
            state: if active.load(Ordering::SeqCst) > 0 { "running".into() } else { "polling".into() },
            tasks_completed: completed.load(Ordering::Relaxed),
            tasks_failed: failed.load(Ordering::Relaxed),
        });

        if active.load(Ordering::SeqCst) >= slots {
            sleep_cancellable(&flag, 1).await; // all slots busy — wait a beat
            continue;
        }

        let wait = app.state::<AppState>().poll_interval.load(Ordering::Relaxed).max(1);
        match protocol::poll(&agent.platform_url, &agent.agent_id, &agent.secret).await {
            Ok(Some(task)) => {
                consecutive_errors = 0;
                active.fetch_add(1, Ordering::SeqCst);
                let app_c = app.clone();
                let agent_c = agent.clone();
                let backend_c = backend.clone();
                let completed_c = completed.clone();
                let failed_c = failed.clone();
                let active_c = active.clone();
                tokio::spawn(async move {
                    run_one_task(&app_c, &agent_c, &backend_c, task, &completed_c, &failed_c).await;
                    active_c.fetch_sub(1, Ordering::SeqCst);
                });
                // Slots free → poll again immediately to fill the next one (the
                // poll's own latency paces it). Otherwise pace by poll_interval.
                if active.load(Ordering::SeqCst) < slots {
                    continue;
                }
                sleep_cancellable(&flag, wait).await;
            }
            Ok(None) => {
                sleep_cancellable(&flag, wait).await; // nothing queued — quiet, next tick
            }
            Err(e) => {
                consecutive_errors += 1;
                emit_event(&app, MiningEvent::Log { line: format!("Poll failed ({consecutive_errors}): {e}") });
                if consecutive_errors >= 5 {
                    emit_event(
                        &app,
                        MiningEvent::Log { line: "5 consecutive failures — stopping. Check your connection and try again.".into() },
                    );
                    notify(&app, "Handsel Miner", "Mining stopped after repeated connection failures — open the app to restart.");
                    break;
                }
                sleep_cancellable(&flag, wait).await;
            }
        }
    }

    // A claimed task always submits: let any in-flight executors finish.
    while active.load(Ordering::SeqCst) > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    emit_event(&app, MiningEvent::Status {
        state: "stopped".into(),
        tasks_completed: completed.load(Ordering::Relaxed),
        tasks_failed: failed.load(Ordering::Relaxed),
    });
    emit_event(&app, MiningEvent::Log { line: "Mining stopped.".into() });
    *app.state::<AppState>().is_mining.lock().await = false;
}

/// Sleep `secs` seconds, bailing early if mining was cancelled.
async fn sleep_cancellable(flag: &Arc<AtomicBool>, secs: u64) {
    for _ in 0..secs.max(1) {
        if !flag.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

/// Run one claimed task to completion: do the work (image / audio / text),
/// submit the result, and surface the grading verdict. Updates the shared
/// session counters. Spawned per task, so several run concurrently.
async fn run_one_task(
    app: &tauri::AppHandle,
    agent: &AgentConfig,
    backend: &ModelBackend,
    task: protocol::PolledTask,
    completed: &Arc<AtomicU32>,
    failed: &Arc<AtomicU32>,
) {
    emit_event(
        app,
        MiningEvent::Log {
            line: format!("Task {}: {}…", task.task_id, task.task.lines().next().unwrap_or("").chars().take(100).collect::<String>()),
        },
    );

    let started = std::time::Instant::now();
    // Image-deliverable tasks (routed here only when image mining declared the
    // capability) go to the generation API; everything else to the chat model.
    // Read the lane-model choices per task so changing the image model / audio
    // voice takes effect without a restart.
    let lane_cfg = load_stored_config(app);
    let img_model = lane_cfg.image_model.clone();
    let aud_voice = lane_cfg.audio_voice.clone();
    let (success, output, artifacts) = if task.deliverable_kind == "image" {
        match protocol::generate_image(&task.task, img_model.as_deref()).await {
            Ok((mime, data_base64)) => (
                true,
                "Generated image attached (desktop miner, prompt derived from the task spec).".to_string(),
                vec![protocol::Artifact {
                    name: if mime.ends_with("png") { "deliverable.png".into() } else { "deliverable.jpg".into() },
                    mime,
                    data_base64,
                }],
            ),
            Err(e) => (false, format!("Image generation failed: {e}"), vec![]),
        }
    } else if task.deliverable_kind == "audio" {
        match protocol::generate_audio(&task.task, aud_voice.as_deref()).await {
            Ok((mime, data_base64)) => (
                true,
                "Narration audio attached (desktop miner, text-to-speech of the task script).".to_string(),
                vec![protocol::Artifact { name: "deliverable.mp3".into(), mime, data_base64 }],
            ),
            Err(e) => (false, format!("Audio generation failed: {e}"), vec![]),
        }
    } else {
        // Harness lane first, when the owner turned it on and it is still
        // genuinely runnable. A lane that stopped being ready (folder
        // deleted, binary uninstalled) falls back to the chat model with a
        // log line — a claimed task always gets a real attempt.
        let hstatus = harness::status(
            lane_cfg.harness_enabled,
            lane_cfg.harness_bin.as_deref(),
            lane_cfg.harness_workdir.as_deref(),
        );
        if lane_cfg.harness_enabled && hstatus.ready {
            let bin = hstatus.chosen.expect("ready implies a harness is installed");
            let workdir = std::path::PathBuf::from(lane_cfg.harness_workdir.clone().expect("ready implies a workdir"));
            emit_event(app, MiningEvent::Log { line: format!("Handing task {} to {} in {}…", task.task_id, bin, workdir.display()) });
            let outcome = harness::run_task(&bin, &workdir, &task.task_id, &task.task, 1800).await;
            if outcome.success && outcome.source == "stdout" {
                emit_event(app, MiningEvent::Log { line: "Harness wrote no deliverable file — submitting its output instead.".into() });
            }
            (outcome.success, outcome.output, vec![])
        } else {
            if lane_cfg.harness_enabled {
                emit_event(app, MiningEvent::Log { line: format!("Harness lane not runnable ({}) — using the chat model for this task.", hstatus.detail) });
            }
            match protocol::ask_model(backend, &task.task).await {
                Ok(text) if !text.trim().is_empty() => (true, text, vec![]),
                Ok(_) => (false, "Local model returned empty output".to_string(), vec![]),
                Err(e) => (false, format!("Local worker error: {e}"), vec![]),
            }
        }
    };
    let elapsed = started.elapsed().as_secs();

    match protocol::submit_result(&agent.platform_url, &agent.agent_id, &agent.secret, &task.task_id, success, &output, elapsed, &artifacts).await {
        Ok(resp) => {
            if success {
                let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                emit_event(app, MiningEvent::Log { line: format!("Done in {elapsed}s — result submitted.") });
                // The callback grades synchronously and returns the verdict, so
                // the log shows what happened to the money, not just "submitted".
                let grading = resp.get("grading");
                match grading.and_then(|g| g.get("settled")).and_then(|s| s.as_str()) {
                    Some("paid") => {
                        emit_event(app, MiningEvent::Log { line: "✅ 채점 통과 — 정산 완료(지급됨).".into() });
                        notify(app, "Handsel Miner", "채점 통과 — 대금이 지급됐어요.");
                    }
                    Some("refunded") => {
                        let reason = grading
                            .and_then(|g| g.get("reason"))
                            .and_then(|r| r.as_str())
                            .map(|r| r.chars().take(200).collect::<String>())
                            .unwrap_or_default();
                        let line = if reason.is_empty() {
                            "❌ 채점 실패 — 요청자에게 환불(지급 없음).".to_string()
                        } else {
                            format!("❌ 채점 실패 — 요청자에게 환불(지급 없음). 사유: {reason}")
                        };
                        emit_event(app, MiningEvent::Log { line });
                        notify(app, "Handsel Miner", "채점 실패로 환불됐어요 — 지급 없음. 로그에서 사유를 확인하세요.");
                    }
                    Some("manual") => {
                        emit_event(app, MiningEvent::Log { line: "⏳ 자동 채점 없음 — 요청자 수동 검토 대기 중.".into() });
                    }
                    _ => {
                        notify(app, "Handsel Miner", &format!("Task completed and submitted ({done} this session) — independent grading decides the payout."));
                    }
                }
            } else {
                failed.fetch_add(1, Ordering::Relaxed);
                emit_event(app, MiningEvent::Log { line: format!("FAILED: {output}") });
                notify(app, "Handsel Miner", "A task failed — see the log for details.");
            }
        }
        Err(e) => {
            failed.fetch_add(1, Ordering::Relaxed);
            emit_event(app, MiningEvent::Log { line: format!("Could not submit result: {e}") });
        }
    }
}

/** Public credit stats for the configured agent — score/rating for the
 *  in-app stats panel. */
#[tauri::command]
async fn get_agent_card(app: tauri::AppHandle) -> Result<protocol::AgentCardStats, String> {
    let cfg = load_stored_config(&app);
    let agent = cfg.agent.ok_or_else(|| "No agent registered yet.".to_string())?;
    protocol::agent_card(&agent.platform_url, &agent.agent_id).await
}

// ---- Delegation (requester side): the Miner can also HAND OUT work. ----
// The password is passed straight through per action and never stored,
// exactly like withdraw_earnings. The stored worker agent doubles as the
// prime agent — its mined USDC funds the escrows.

fn require_agent(app: &tauri::AppHandle) -> Result<AgentConfig, String> {
    let cfg = load_stored_config(app);
    let agent = cfg.agent.ok_or_else(|| "No agent registered yet.".to_string())?;
    if agent.email.is_empty() {
        return Err("This install predates delegation support — use \"Use a different account\" and reconnect once.".to_string());
    }
    Ok(agent)
}

#[tauri::command]
async fn plan_delegation(
    app: tauri::AppHandle,
    goal: String,
    budget_usd: f64,
    password: String,
) -> Result<serde_json::Value, String> {
    let agent = require_agent(&app)?;
    protocol::delegation_plan(&agent.platform_url, &agent.email, &password, &agent.agent_id, &goal, budget_usd).await
}

#[tauri::command]
async fn confirm_delegation(app: tauri::AppHandle, id: String, password: String) -> Result<serde_json::Value, String> {
    let agent = require_agent(&app)?;
    protocol::delegation_confirm(&agent.platform_url, &agent.email, &password, &id).await
}

#[tauri::command]
async fn discard_delegation(app: tauri::AppHandle, id: String, password: String) -> Result<serde_json::Value, String> {
    let agent = require_agent(&app)?;
    protocol::delegation_discard(&agent.platform_url, &agent.email, &password, &id).await
}

#[tauri::command]
async fn delegation_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let cfg = load_stored_config(&app);
    let agent = cfg.agent.ok_or_else(|| "No agent registered yet.".to_string())?;
    protocol::delegation_status(&agent.platform_url, &agent.agent_id, &agent.secret).await
}

/// $LEDGER governance from the Miner: view/lock/vote/review/set_auto_vote.
/// Worker-secret auth — earned-token governance, no money movement.
#[tauri::command]
async fn governance(
    app: tauri::AppHandle,
    action: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let cfg = load_stored_config(&app);
    let agent = cfg.agent.ok_or_else(|| "No agent registered yet.".to_string())?;
    protocol::governance(&agent.platform_url, &agent.agent_id, &agent.secret, &action, args).await
}


// ── Repo-job lane ───────────────────────────────────────────────────────

#[tauri::command]
async fn repo_lane_status(app: tauri::AppHandle) -> Result<repo_lane::RepoLaneReadiness, String> {
    let cfg = load_config(app);
    let ws = cfg.repo_workspace.map(PathBuf::from);
    Ok(repo_lane::readiness(ws).await)
}

/// Ask the owner for a workspace folder and remember it. The dialog IS the
/// consent: nothing is cloned anywhere until this returns a path.
#[tauri::command]
async fn pick_repo_workspace(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Choose a folder for repo-job clones")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None); // cancelled — not an error, and nothing is stored
    };
    let display = path.display().to_string();
    let mut cfg = load_config(app.clone());
    cfg.repo_workspace = Some(display.clone());
    save_stored_config(&app, &cfg)?;
    Ok(Some(display))
}

#[tauri::command]
fn clear_repo_workspace(app: tauri::AppHandle) -> Result<(), String> {
    let mut cfg = load_config(app.clone());
    cfg.repo_workspace = None;
    save_stored_config(&app, &cfg)
}

/// Work one repo job end to end. Long-running by nature (clone + a real
/// coding loop), so the UI shows a spinner rather than polling.
#[tauri::command]
async fn run_repo_job(
    app: tauri::AppHandle,
    min_bounty_usd: Option<f64>,
    dry_run: Option<bool>,
) -> Result<repo_lane::RepoRunResult, String> {
    let cfg = load_config(app);
    let agent = cfg.agent.ok_or("Sign in first")?;
    let workspace = cfg
        .repo_workspace
        .ok_or("Choose a workspace folder before running repo jobs")?;
    Ok(repo_lane::run_once(
        &agent.platform_url,
        &agent.agent_id,
        &agent.secret,
        std::path::Path::new(&workspace),
        min_bounty_usd,
        dry_run.unwrap_or(false),
    )
    .await)
}

// ── Harness lane ────────────────────────────────────────────────────────

#[tauri::command]
fn harness_status(app: tauri::AppHandle) -> harness::HarnessStatus {
    let cfg = load_stored_config(&app);
    harness::status(cfg.harness_enabled, cfg.harness_bin.as_deref(), cfg.harness_workdir.as_deref())
}

/// Ask the owner for the harness scratch folder. The dialog IS the consent —
/// same boundary as the repo lane's workspace, and for a stronger reason:
/// every harness runs with its auto-approval flag.
#[tauri::command]
async fn pick_harness_workdir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Choose a THROWAWAY scratch folder for harness jobs")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None); // cancelled — not an error, nothing stored
    };
    let display = path.display().to_string();
    let mut cfg = load_stored_config(&app);
    cfg.harness_workdir = Some(display.clone());
    save_stored_config(&app, &cfg)?;
    Ok(Some(display))
}

/// Turn the harness lane on/off and optionally pin which harness. Enabling
/// also declares code/file capability so the matcher routes real engineering
/// work here; disabling withdraws it — a declared-but-unfulfillable lane
/// just claims-and-fails jobs.
#[tauri::command]
async fn set_harness(
    app: tauri::AppHandle,
    enabled: bool,
    bin: Option<String>,
) -> Result<harness::HarnessStatus, String> {
    let mut cfg = load_stored_config(&app);
    let agent = cfg.agent.clone().ok_or_else(|| "No agent registered yet.".to_string())?;
    if enabled && cfg.harness_workdir.as_deref().map(|w| std::path::Path::new(w).exists()) != Some(true) {
        return Err("Choose a scratch folder first — it is the harness's permission boundary.".into());
    }
    let mut caps: Vec<&str> = vec!["text"];
    if cfg.image_mining {
        caps.push("image");
    }
    if enabled {
        caps.push("code");
        caps.push("file");
    }
    protocol::update_capabilities(&agent.platform_url, &agent.agent_id, &agent.secret, &caps).await?;
    cfg.harness_enabled = enabled;
    cfg.harness_bin = bin.filter(|s| !s.is_empty());
    save_stored_config(&app, &cfg)?;
    Ok(harness::status(cfg.harness_enabled, cfg.harness_bin.as_deref(), cfg.harness_workdir.as_deref()))
}

// ── Deep link (handsel://connect?token=…) ───────────────────────────────

/// Decode the dashboard's worker token — the same base64url {a,s,u} payload
/// --token takes on the Node worker — into an AgentConfig. Name/email are
/// unknown to the token; the name is fetched later, the email stays empty
/// (withdraw/delegation prompt to reconnect, as for any pre-email install).
fn parse_connect_token(token: &str) -> Option<AgentConfig> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.trim().trim_end_matches('='))
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let a = v.get("a")?.as_str()?.to_string();
    let s = v.get("s")?.as_str()?.to_string();
    let u = v.get("u")?.as_str()?.trim_end_matches('/').to_string();
    if a.is_empty() || s.is_empty() || !u.starts_with("https://") {
        return None;
    }
    Some(AgentConfig { platform_url: u, agent_id: a, secret: s, name: String::new(), email: String::new() })
}

/// The pending deep-link connect, for the UI's confirm banner. Secret never
/// leaves the Rust side — the frontend only sees what it must display.
#[tauri::command]
async fn pending_connect_info(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let pending = state.pending_connect.lock().await;
    Ok(pending.as_ref().map(|c| {
        serde_json::json!({ "agent_id": c.agent_id, "platform_url": c.platform_url })
    }))
}

#[tauri::command]
async fn confirm_pending_connect(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let Some(mut connect) = state.pending_connect.lock().await.take() else {
        return Err("Nothing pending.".into());
    };
    // Best-effort display name from the public agent card.
    if let Ok(card) = protocol::agent_card(&connect.platform_url, &connect.agent_id).await {
        connect.name = card.name;
    }
    let mut cfg = load_stored_config(&app);
    cfg.agent = Some(connect);
    save_stored_config(&app, &cfg)
}

#[tauri::command]
async fn reject_pending_connect(state: State<'_, AppState>) -> Result<(), String> {
    *state.pending_connect.lock().await = None;
    Ok(())
}

fn handle_deep_link(app: &tauri::AppHandle, url: &tauri::Url) {
    if url.scheme() != "handsel" {
        return;
    }
    // handsel://connect?token=… — host carries "connect" for a scheme URL.
    let action = url.host_str().unwrap_or_else(|| url.path().trim_start_matches('/'));
    if action != "connect" {
        return;
    }
    let Some(token) = url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.to_string()) else {
        return;
    };
    let Some(connect) = parse_connect_token(&token) else {
        emit_event(app, MiningEvent::Log { line: "Ignored a handsel:// link with an unreadable token.".into() });
        return;
    };
    let display = serde_json::json!({ "agent_id": connect.agent_id, "platform_url": connect.platform_url });
    let app_c = app.clone();
    tauri::async_runtime::spawn(async move {
        *app_c.state::<AppState>().pending_connect.lock().await = Some(connect);
        let _ = app_c.emit("deep-link-connect", display);
        if let Some(w) = app_c.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            default_platform_url,
            load_config,
            register_agent,
            forget_account,
            detect_ollama,
            list_models,
            list_image_models,
            save_lane_models,
            save_backend,
            start_mining,
            stop_mining,
            set_poll_interval,
            set_concurrency,
            get_concurrency,
            get_wallet,
            withdraw_earnings,
            get_agent_card,
            plan_delegation,
            confirm_delegation,
            discard_delegation,
            delegation_status,
            governance,
            set_image_mining,
            set_lanes,
            open_url,
            repo_lane_status,
            pick_repo_workspace,
            clear_repo_workspace,
            run_repo_job,
            harness_status,
            pick_harness_workdir,
            set_harness,
            pending_connect_info,
            confirm_pending_connect,
            reject_pending_connect,
        ])
        .setup(|app| {
            // handsel:// deep links: register at runtime where the OS allows
            // (Linux/Windows; macOS reads it from the bundle), then listen.
            // Every received link only STAGES a connect — see pending_connect.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("[miner] deep-link registration unavailable: {e}");
                }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&handle, &url);
                    }
                });
            }
            // System tray: the Miner's real home. Closing the window hides
            // it here and mining keeps running — a background earner, not a
            // window you have to babysit. BEST-EFFORT: on Linux the tray
            // needs libayatana-appindicator; if it can't be created, the
            // app must still run (and close must actually quit — see
            // on_window_event), never crash.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            let build_tray = || -> tauri::Result<()> {
                let show = MenuItem::with_id(app, "show", "Open Handsel Miner", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit (stops mining)", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;
                let icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or_else(|| tauri::Error::AssetNotFound("window icon".into()))?;
                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("Handsel Miner")
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
                Ok(())
            };
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(build_tray)) {
                Ok(Ok(())) => TRAY_AVAILABLE.store(true, Ordering::SeqCst),
                Ok(Err(e)) => eprintln!("[miner] tray unavailable ({e}) — running without one"),
                Err(_) => eprintln!("[miner] tray unavailable (missing system appindicator library) — running without one"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // With a tray: hide, mining continues in the background.
                // Without one there is nothing to reopen from — hiding
                // would strand an invisible process, so let close mean quit.
                if TRAY_AVAILABLE.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Handsel Miner");
}
