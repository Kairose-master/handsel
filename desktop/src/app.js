const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

// ---------- i18n (EN default, KO toggle) ----------

const KO = {
  'harness.title': '🤖 코딩 하네스 — 클로드 코드에게 일 맡기기',
  'harness.hint': '채팅 모델 대신, claim한 텍스트 잡을 이 컴퓨터에 설치된 진짜 코딩 에이전트(Claude Code, Codex, OpenCode, Cline, Gemini CLI)에게 통째로 넘깁니다 — 여러분이 고른 스크래치 폴더 안에서 실제 파일을 읽고 씁니다. 하네스는 자동승인 모드로 돌아 그 폴더 안에서 뭐든 편집·실행할 수 있으니, 버려도 되는 폴더만 고르세요 — 홈 디렉터리나 자격증명이 있는 곳은 절대 금지. 하네스가 결과 파일에 쓴 내용이 제출되고 독립 채점됩니다.',
  'harness.pick': '스크래치 폴더 선택',
  'harness.toggle': 'claim한 텍스트 잡을 하네스에게 넘기기',
  'harness.bin': '하네스',
  'deeplink.confirm': '이 에이전트 연결',
  'deeplink.reject': '무시',
  'repo.title': '🐙 레포 작업 — diff로 돈 받기',
  'repo.hint': 'GitHub 레포 작업은 요청자의 CI를 통과하는 PR에 값을 지불합니다. 이 컴퓨터가 공개 레포를 여러분이 고른 폴더에 클론하고, 현상금을 상한으로 한 예산 안에서 Foreman으로 작업한 뒤, 통합 diff를 제출합니다. 저장소 자격증명은 절대 받지 않고 푸시도 할 수 없습니다 — PR은 플랫폼이 열고, 머지가 에스크로를 풉니다.',
  'repo.pick': '작업 폴더 선택',
  'repo.dry': '게시판 확인',
  'repo.run': '한 건 작업하기',
  subtitle: '다운로드하면 내 모델이 백그라운드에서 USDC를 벌어요 — 텍스트·이미지 일감, 터미널 없이. 채굴 펫 키우고, 일감 맡기고, Claude/ChatGPT에 연결까지.',
  'reg.title': '1. 계정 연결',
  'reg.hint': '처음이신가요? 계정과 워커 에이전트가 한 번에 만들어져요. 이미 Handsel 계정이 있다면 같은 이메일/비밀번호를 입력하면 새 에이전트가 추가됩니다.',
  'reg.email': '이메일',
  'reg.password': '비밀번호',
  'reg.agentName': '에이전트 이름',
  'reg.advanced': '고급 설정',
  'reg.platformUrl': '플랫폼 URL',
  'reg.submit': '계정 생성 / 연결',
  'backend.title': '2. 모델 선택',
  'backend.detecting': '로컬 Ollama 설치를 찾는 중…',
  'backend.found': 'Ollama가 실행 중이에요. 설치된 모델을 고르세요:',
  'backend.model': '모델',
  'backend.useModel': '이 모델 사용',
  'backend.cloudIntro': '로컬 Ollama가 없어요.',
  'backend.retry': 'Ollama 설치 후 다시 시도',
  'backend.cloudMid': '하거나, 무료/저가 클라우드 API 키를 붙여넣어 호스팅 모델로 채굴할 수 있어요 (예:',
  'backend.cloudEnd': '키 — OpenAI 호환, 넉넉한 무료 티어):',
  'backend.baseUrl': 'API 베이스 URL',
  'backend.apiKey': 'API 키',
  'backend.model2': '모델',
  'backend.loadModels': '모델 찾아보기…',
  'backend.searchModels': '모델 검색…',
  'backend.visionOnly': '🖼️ 이미지 가능 모델만',
  'backend.useEndpoint': '이 엔드포인트 사용',
  'backend.cloudMid3': ', 또는 호스팅 모델을 연결하세요 — 프로바이더를 고르고, 키를 붙여넣고, 채굴:',
  'backend.providerOther': '직접 입력',
  'stat.completed': '완료',
  'stat.failed': '실패',
  'stat.balance': 'USDC 수익',
  'stat.credit': '신용점수',
  'mine.start': '채굴 시작',
  'mine.stop': '채굴 중지',
  'mine.trayHint': '창을 닫아도 트레이에서 채굴이 계속돼요 — 트레이 아이콘으로 다시 열 수 있어요.',
  'mine.forget': '다른 계정 사용',
  'withdraw.title': '수익 인출',
  'withdraw.hint': '이 워커의 USDC 잔액을 내 지갑 주소(예: MetaMask 주소 복사)로 보냅니다. 돈을 옮길 땐 계정 비밀번호가 필요해요 — 워커 키만으로는 절대 인출할 수 없습니다. 현재는 테스트넷 USDC예요.',
  'withdraw.to': '받는 주소',
  'withdraw.password': '계정 비밀번호',
  'withdraw.submit': '인출',
  'gov.title': '🗳️ 거버넌스 ($LEDGER)',
  'gov.hint': '$LEDGER는 완료한 작업으로 버는 토큰 — 사는 게 아니에요. 락하면 투표권이 생겨 플랫폼 방향을 정할 수 있어요. 신뢰받는 에이전트는 나 대신 투표도 하고, 확신 없는 건은 여기서 내 결정을 기다려요.',
  'gov.power': '투표권',
  'gov.balance': '$LEDGER 여유',
  'gov.locked': '락된 양',
  'gov.earned': '총 획득',
  'gov.lockAmount': '락 수량',
  'gov.lockWeeks': '주 (1–52)',
  'gov.lock': '락하기',
  'gov.autoVote': '🤖 이 에이전트가 나 대신 자동투표 (내가 믿고 켜면 됨 — 신용점수 무관)',
  'gov.savePolicy': '정책 저장',
  'game.pet': '채굴 펫',
  'game.shop': '상점',
  'mine.imageToggle': '🖼️ 이미지 일감도 채굴 (무료 생성 API — 경쟁 적고 보수 좋은 레인)',
  'mine.audioToggle': '🔊 오디오 일감도 채굴 (무료 TTS — 스크립트를 읽어 음성 생성, 음성인식으로 채점)',
  'mine.imageModel': '이미지 모델',
  'mine.concurrency': '동시 작업 수',
  'mine.audioVoice': '음성 / 언어',
  'mine.default': '기본',
  'connect.title': '🔗 Claude / ChatGPT에서 Handsel 쓰기',
  'connect.hint': '이 계정은 MCP 커넥터로도 동작해요: Claude나 ChatGPT 대화 안에서 "10달러로 하청 줘"라고 위임하거나, 모델이 직접 일감을 수주해 USDC를 벌게 할 수 있어요. URL 하나면 되고 이 계정으로 승인합니다 — Claude 웹·Claude Desktop·ChatGPT(개발자 모드) 모두 지원.',
  'connect.open': '연결 가이드 열기',
  'delegate.title': '일감 맡기기 (다른 에이전트 고용)',
  'delegate.hint': '이번엔 반대편에 서 보세요: 목표를 적으면 플랫폼 플래너가 보수가 책정된 하위 작업으로 쪼개주고, 정확한 계획을 승인한 뒤에야 채굴로 번 USDC가 에스크로됩니다. 다른 에이전트들이 작업을 수행하고, 검수를 통과한 제출물엔 자동으로 지급되며 조립된 결과물이 아래에 표시됩니다.',
  'delegate.goal': '무엇을 맡기시겠어요?',
  'delegate.budget': '예산 (USDC)',
  'delegate.password': '계정 비밀번호',
  'delegate.plan': '하위 작업 설계 (돈 안 나감)',
  'delegate.review': '설계된 계획 — 승인해야만 돈이 움직입니다:',
  'delegate.confirm': '승인·게시 (보수 에스크로)',
  'delegate.discard': '버리기',
}

let lang = localStorage.getItem('miner-lang') || 'en'

function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    if (lang === 'ko' && KO[key]) {
      if (!el.dataset.en) el.dataset.en = el.textContent
      el.textContent = KO[key]
    } else if (el.dataset.en) {
      el.textContent = el.dataset.en
    }
  })
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph')
    if (lang === 'ko' && KO[key]) {
      if (!el.dataset.enPh) el.dataset.enPh = el.placeholder
      el.placeholder = KO[key]
    } else if (el.dataset.enPh) {
      el.placeholder = el.dataset.enPh
    }
  })
  const toggle = document.getElementById('lang-toggle')
  if (toggle) toggle.textContent = lang === 'ko' ? 'English' : '한국어'
}

const views = {
  register: document.getElementById('view-register'),
  backend: document.getElementById('view-backend'),
  mining: document.getElementById('view-mining'),
}

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name
}

function setText(id, text) {
  document.getElementById(id).textContent = text
}

function showError(id, message) {
  const el = document.getElementById(id)
  el.textContent = message
  el.hidden = !message
}

// ---------- Step 1: account ----------

async function initRegisterView() {
  const platformInput = document.getElementById('reg-platform')
  platformInput.placeholder = await invoke('default_platform_url')

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    showError('register-error', '')
    const submitBtn = document.getElementById('register-submit')
    submitBtn.disabled = true
    submitBtn.textContent = 'Connecting…'
    try {
      const email = document.getElementById('reg-email').value.trim()
      const password = document.getElementById('reg-password').value
      const name = document.getElementById('reg-name').value.trim()
      const platform_url = platformInput.value.trim() || platformInput.placeholder
      await invoke('register_agent', { platformUrl: platform_url, email, password, name })
      await enterBackendView()
    } catch (err) {
      showError('register-error', String(err))
    } finally {
      submitBtn.disabled = false
      submitBtn.textContent = 'Create / connect agent'
    }
  })
}

// ---------- Step 2: model backend ----------

async function enterBackendView() {
  showView('backend')
  showError('backend-error', '')
  document.getElementById('backend-detecting').hidden = false
  document.getElementById('backend-ollama').hidden = true
  document.getElementById('backend-cloud').hidden = true

  try {
    const models = await invoke('detect_ollama')
    document.getElementById('backend-detecting').hidden = true
    if (models.length > 0) {
      const select = document.getElementById('ollama-model')
      select.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join('')
      document.getElementById('backend-ollama').hidden = false
    } else {
      showBackendCloudFallback('Ollama is running but has no models pulled yet — run `ollama pull llama3.2`, or use a cloud key below.')
    }
  } catch {
    document.getElementById('backend-detecting').hidden = true
    showBackendCloudFallback()
  }
}

function showBackendCloudFallback(note) {
  document.getElementById('backend-cloud').hidden = false
  if (note) showError('backend-error', note)
}

// Hosted model providers. All are OpenAI-compatible, so they all save as the
// same `open_ai_compatible` backend — the chips just pre-fill the endpoint,
// key hint, and a sensible default model so the user never types a base URL.
const PROVIDERS = {
  groq: { base: 'https://api.groq.com/openai/v1', keyHint: 'gsk_...', model: 'llama-3.3-70b-versatile', keys: 'https://console.groq.com/keys' },
  openrouter: { base: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-...', model: 'meta-llama/llama-3.3-70b-instruct', keys: 'https://openrouter.ai/keys' },
  huggingface: { base: 'https://router.huggingface.co/v1', keyHint: 'hf_...', model: 'meta-llama/Llama-3.3-70B-Instruct', keys: 'https://huggingface.co/settings/tokens' },
  other: { base: '', keyHint: 'API key', model: '', keys: null },
}

function applyProvider(name) {
  const p = PROVIDERS[name]
  if (!p) return
  const baseEl = document.getElementById('cloud-base-url')
  const keyEl = document.getElementById('cloud-api-key')
  const modelEl = document.getElementById('cloud-model')
  baseEl.value = p.base
  keyEl.placeholder = p.keyHint
  if (p.model) modelEl.value = p.model
  document.querySelectorAll('.provider-chip').forEach((c) => c.classList.toggle('active', c.dataset.provider === name))
  const hint = document.getElementById('provider-hint')
  if (p.keys) {
    const label = lang === 'ko' ? '무료/저가 키 발급 → ' : 'Get a free / low-cost key → '
    hint.innerHTML = `${label}<a href="${p.keys}" target="_blank" rel="noreferrer">${p.keys.replace(/^https?:\/\//, '')}</a>`
  } else {
    hint.textContent = lang === 'ko' ? '아무 OpenAI 호환 엔드포인트나 직접 입력하세요.' : 'Enter any OpenAI-compatible endpoint manually.'
  }
}

// ---------- Model picker (searchable, capability-aware) ----------
//
// The old flow was a blank "type the model id" box, which is how a text-only
// model ends up claiming image jobs and failing. This loads the provider's
// real model list (OpenAI-compatible /models, via Rust so CSP doesn't block
// it) and lets the user search it and filter to image-capable models.

let allModels = []

function resetModelPicker() {
  allModels = []
  const list = document.getElementById('model-list')
  const tools = document.getElementById('model-tools')
  const status = document.getElementById('model-status')
  const search = document.getElementById('model-search')
  if (list) { list.hidden = true; list.innerHTML = '' }
  if (tools) tools.hidden = true
  if (status) status.hidden = true
  if (search) search.value = ''
  const vo = document.getElementById('vision-only')
  if (vo) vo.checked = false
}

function fmtCtx(n) {
  if (!n) return ''
  return n >= 1000 ? `${Math.round(n / 1000)}K ctx` : `${n} ctx`
}

async function loadModels() {
  const base = document.getElementById('cloud-base-url').value.trim()
  const key = document.getElementById('cloud-api-key').value.trim()
  const status = document.getElementById('model-status')
  status.hidden = false
  status.classList.remove('err')
  status.textContent = lang === 'ko' ? '모델 불러오는 중…' : 'Loading models…'
  try {
    allModels = await invoke('list_models', { baseUrl: base, apiKey: key })
    document.getElementById('model-tools').hidden = false
    document.getElementById('model-list').hidden = false
    renderModelList()
    const anyVision = allModels.some((m) => m.vision)
    status.textContent = lang === 'ko'
      ? `${allModels.length}개 모델${anyVision ? ' · 🖼️ 이미지 가능 모델 있음' : ''}`
      : `${allModels.length} models${anyVision ? ' · 🖼️ some image-capable' : ''}`
  } catch (e) {
    status.classList.add('err')
    status.textContent = String(e)
  }
}

function renderModelList() {
  const list = document.getElementById('model-list')
  const q = document.getElementById('model-search').value.trim().toLowerCase()
  const visionOnly = document.getElementById('vision-only').checked
  const current = document.getElementById('cloud-model').value.trim()
  let rows = allModels
  if (visionOnly) rows = rows.filter((m) => m.vision)
  if (q) rows = rows.filter((m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
  const CAP = 80
  const shown = rows.slice(0, CAP)
  list.innerHTML = ''
  if (shown.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'model-empty'
    empty.textContent = lang === 'ko' ? '일치하는 모델이 없어요.' : 'No matching models.'
    list.appendChild(empty)
    return
  }
  for (const m of shown) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'model-row' + (m.id === current ? ' active' : '')
    const meta = [m.vision ? '🖼️' : '', fmtCtx(m.context)].filter(Boolean).join(' · ')
    const idSpan = document.createElement('span')
    idSpan.className = 'model-id'
    idSpan.textContent = m.id
    const metaSpan = document.createElement('span')
    metaSpan.className = 'model-meta'
    metaSpan.textContent = meta
    row.appendChild(idSpan)
    row.appendChild(metaSpan)
    row.addEventListener('click', () => {
      document.getElementById('cloud-model').value = m.id
      renderModelList()
    })
    list.appendChild(row)
  }
  if (rows.length > CAP) {
    const more = document.createElement('div')
    more.className = 'model-empty'
    more.textContent = lang === 'ko' ? `+${rows.length - CAP}개 더 — 검색으로 좁혀보세요` : `+${rows.length - CAP} more — refine your search`
    list.appendChild(more)
  }
}

function initBackendView() {
  document.getElementById('use-ollama').addEventListener('click', async () => {
    const model = document.getElementById('ollama-model').value
    await invoke('save_backend', { backend: { kind: 'ollama', base_url: 'http://localhost:11434', model } })
    await enterMiningView()
  })

  document.getElementById('retry-ollama').addEventListener('click', (e) => {
    e.preventDefault()
    enterBackendView()
  })

  document.querySelectorAll('.provider-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const name = chip.dataset.provider
      applyProvider(name)
      resetModelPicker()
      // OpenRouter's /models is keyless — load it immediately so the user
      // sees the real list (and can filter to image-capable) without a key.
      if (name === 'openrouter') loadModels()
    })
  })
  document.getElementById('load-models').addEventListener('click', loadModels)
  document.getElementById('model-search').addEventListener('input', renderModelList)
  document.getElementById('vision-only').addEventListener('change', renderModelList)
  // Default the cloud fallback to a sensible provider so the fields aren't blank.
  applyProvider('groq')

  document.getElementById('cloud-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const base_url = document.getElementById('cloud-base-url').value.trim()
    const api_key = document.getElementById('cloud-api-key').value.trim()
    const model = document.getElementById('cloud-model').value.trim()
    await invoke('save_backend', { backend: { kind: 'open_ai_compatible', base_url, api_key, model } })
    await enterMiningView()
  })
}

// ---------- Minigame: Miner Buddy ----------
//
// A game layer over the *real* mining stats — nothing here is simulated.
// Completed tasks grant XP (with a streak bonus), the pet evolves at level
// thresholds, and achievements unlock off task counts, streaks, balance and
// credit rating. State persists in localStorage so it survives restarts.

const GAME_KEY = 'miner-game-v1'

const PET_STAGES = [
  [1, '🥚'], [3, '🐣'], [5, '🤖'], [8, '🦾'], [12, '👑'], [16, '🐉'], [20, '🌟'],
]

const ACHIEVEMENTS = [
  { id: 'first_task', emoji: '🎯', en: 'First task completed', ko: '첫 작업 완료' },
  { id: 'tasks10', emoji: '⚒️', en: '10 tasks completed', ko: '작업 10개 완료' },
  { id: 'tasks50', emoji: '🏭', en: '50 tasks completed', ko: '작업 50개 완료' },
  { id: 'streak5', emoji: '🔥', en: '5-task streak', ko: '연속 5개 성공' },
  { id: 'streak10', emoji: '🌋', en: '10-task streak', ko: '연속 10개 성공' },
  { id: 'dollar1', emoji: '💵', en: 'First $1 earned', ko: '첫 $1 달성' },
  { id: 'dollar10', emoji: '💰', en: '$10 earned', ko: '$10 달성' },
  { id: 'level5', emoji: '⭐', en: 'Reached level 5', ko: '레벨 5 달성' },
  { id: 'level10', emoji: '🌟', en: 'Reached level 10', ko: '레벨 10 달성' },
  { id: 'credit_a', emoji: '🏆', en: 'A-tier credit rating', ko: '신용 A등급' },
  { id: 'first_vote', emoji: '🗳️', en: 'Cast your first vote', ko: '첫 투표 완료' },
  { id: 'first_lock', emoji: '🔒', en: 'Locked $LEDGER for power', ko: '$LEDGER 첫 락' },
  { id: 'delegate_on', emoji: '🤖', en: 'Delegate voting enabled', ko: '위임투표 활성화' },
  { id: 'audio_lane', emoji: '🎧', en: 'Unlocked the audio lane', ko: '오디오 레인 해금' },
  { id: 'prestige1', emoji: '⭐', en: 'Prestiged your buddy', ko: '첫 프레스티지' },
]

// Idle-game economy: 💎 shards are a pure GAME currency (never USDC, never
// on-chain) earned from real completed tasks, streaks, quests, and petting
// the buddy. They buy multipliers (XP booster / shard magnet), streak
// insurance (combo shield) and cosmetics — the numbers that go up faster
// are still driven only by real mining.
const UPGRADES = [
  { id: 'xp', emoji: '⚡', en: 'XP Booster', ko: 'XP 부스터', max: 5, bonus: '+20% XP', cost: (t) => 60 * 2 ** t },
  { id: 'magnet', emoji: '🧲', en: 'Shard Magnet', ko: '조각 자석', max: 5, bonus: '+20% 💎', cost: (t) => 60 * 2 ** t },
]
const SHIELD = { cost: 80, max: 3 }
const HATS = [
  { id: 'cap', emoji: '⛑️', cost: 120 },
  { id: 'tophat', emoji: '🎩', cost: 300 },
  { id: 'crown', emoji: '👑', cost: 800 },
]
// Reflex training — the REAL idle lever. 💎 (earned only from real completed
// jobs) trains the miner's poll cadence faster, so it genuinely grabs real
// jobs sooner → measurably higher real $/day. No fake currency is minted;
// the payoff is downstream USDC, shown live. `game.drones` = reflex tier.
const REFLEX_SECS = [9, 7, 6, 5, 4, 3] // poll seconds by tier (index 0..5)
const REFLEX_MAX = REFLEX_SECS.length - 1
const REFLEX = { baseCost: 60, growth: 1.9 }
function reflexTier() { return Math.min(REFLEX_MAX, game.drones || 0) }
function pollSecsForTier(t) { return REFLEX_SECS[Math.min(REFLEX_MAX, Math.max(0, t))] }
function reflexCost(tier) { return Math.floor(REFLEX.baseCost * REFLEX.growth ** tier) }

// Lanes: real deliverable capabilities. Audio is a one-time 💎 unlock (the
// image lane stays free — it already existed). Both only ever declare a
// capability the miner can genuinely fulfill.
const AUDIO_LANE_COST = 200
// Prestige: gated on REAL completed jobs (cumulative), rising each star.
function prestigeReq(p) { return 25 * (p + 1) }
function canPrestige() { return (game.total || 0) >= prestigeReq(game.prestige || 0) }
const QUESTS = [
  { id: 'q_tasks', goal: 3, reward: 40, en: 'Complete 3 tasks today', ko: '오늘 작업 3개 완료', progress: (s) => s.tasksToday },
  { id: 'q_streak', goal: 4, reward: 30, en: 'Reach a 4-task streak', ko: '연속 4개 성공', progress: (s) => s.streak },
  { id: 'q_clicks', goal: 20, reward: 20, en: 'Pet your buddy 20 times', ko: '펫 20번 쓰다듬기', progress: (s) => s.clicksToday },
]

function loadGame() {
  let raw = null
  try {
    const parsed = JSON.parse(localStorage.getItem(GAME_KEY))
    if (parsed && typeof parsed.xp === 'number') raw = parsed
  } catch { /* corrupted state — start over */ }
  // v1 saves lack the idle-economy fields — fill defaults, keep progress.
  return Object.assign(
    {
      xp: 0, level: 1, total: 0, streak: 0, best: 0, ach: {},
      shards: 0, upgrades: { xp: 0, magnet: 0 }, shields: 0,
      hats: [], hat: null,
      day: '', tasksToday: 0, clicksToday: 0, questsClaimed: [],
      lastSeen: null,
      // Idle throughput: `drones` is the trained REFLEX TIER — it retunes the
      // real miner's poll cadence (faster = grabs real jobs sooner). No fake
      // currency: 💎 come only from real completed jobs. (idleAcc/lastTick
      // kept for save-compat.)
      drones: 0, idleAcc: 0, lastTick: null,
      // Real deliverable lanes the miner works (declared capabilities). Only
      // enabled if genuinely fulfillable: image via generation, audio via TTS.
      lanes: { image: false, audioUnlocked: false, audio: false },
      // Prestige: a game-layer meta-loop GATED ON REAL WORK. Resets the grind
      // layer for a permanent 💎/XP multiplier. Never touches real throughput.
      prestige: 0,
    },
    raw || {},
  )
}

const game = loadGame()
// Normalize the nested lanes object (shallow Object.assign above can leave a
// partial `lanes` from an older save missing new subfields).
game.lanes = Object.assign({ image: false, audioUnlocked: false, audio: false }, game.lanes || {})

/** Daily rollover for quest counters — called before anything reads them. */
function rollDay() {
  const today = new Date().toISOString().slice(0, 10)
  if (game.day !== today) {
    game.day = today
    game.tasksToday = 0
    game.clicksToday = 0
    game.questsClaimed = []
  }
}

function saveGame() {
  localStorage.setItem(GAME_KEY, JSON.stringify(game))
}

// XP needed to go from `level` to `level + 1`.
function xpNeeded(level) {
  return 50 + (level - 1) * 25
}

function petForLevel(level) {
  let sprite = PET_STAGES[0][1]
  for (const [min, emoji] of PET_STAGES) if (level >= min) sprite = emoji
  return sprite
}

// Queued toasts: multiple events at once (boot achievements + away
// earnings, level-up + quest) show one after another instead of the last
// writer silently eating the rest.
const toastQueue = []
let toastShowing = false

function showToast(message) {
  toastQueue.push(message)
  if (!toastShowing) nextToast()
}

function nextToast() {
  const el = document.getElementById('toast')
  const message = toastQueue.shift()
  if (message === undefined) {
    toastShowing = false
    el.hidden = true
    return
  }
  toastShowing = true
  el.textContent = message
  el.hidden = false
  setTimeout(nextToast, 2600)
}

function unlock(id) {
  if (game.ach[id]) return
  const def = ACHIEVEMENTS.find((a) => a.id === id)
  if (!def) return
  game.ach[id] = Date.now()
  saveGame()
  const name = lang === 'ko' ? def.ko : def.en
  const label = lang === 'ko' ? '업적 달성' : 'Achievement unlocked'
  showToast(`${def.emoji} ${label}: ${name}`)
  appendLog(`🏅 ${label}: ${name}`)
  renderGame()
}

function bouncePet() {
  const el = document.getElementById('pet-sprite')
  el.classList.remove('bounce')
  void el.offsetWidth // restart the CSS animation
  el.classList.add('bounce')
}

function addXp(amount) {
  game.xp += amount
  let leveled = false
  while (game.xp >= xpNeeded(game.level)) {
    game.xp -= xpNeeded(game.level)
    game.level += 1
    leveled = true
  }
  if (leveled) {
    const msg = lang === 'ko'
      ? `${petForLevel(game.level)} 레벨 업! Lv.${game.level}`
      : `${petForLevel(game.level)} Level up! Now Lv.${game.level}`
    showToast(msg)
    appendLog(`🎉 ${msg}`)
    if (game.level >= 5) unlock('level5')
    if (game.level >= 10) unlock('level10')
  }
}

// Prestige adds a permanent +25%/star to game-layer gains (💎 + XP). It's a
// game currency booster only — real throughput (reflex/lanes) is untouched.
function prestigeMult() {
  return 1 + 0.25 * (game.prestige || 0)
}
function xpMultiplier() {
  return (1 + 0.2 * (game.upgrades?.xp ?? 0)) * prestigeMult()
}
function shardMultiplier() {
  return (1 + 0.2 * (game.upgrades?.magnet ?? 0)) * prestigeMult()
}

function gainShards(base) {
  const amount = Math.round(base * shardMultiplier())
  game.shards += amount
  return amount
}

function onTaskDone() {
  rollDay()
  game.total += 1
  game.tasksToday += 1
  game.streak += 1
  if (game.streak > game.best) game.best = game.streak
  // 10 XP per task + streak bonus (2 XP per consecutive task, capped at +20)
  addXp(Math.round((10 + Math.min((game.streak - 1) * 2, 20)) * xpMultiplier()))
  const got = gainShards(5 + Math.min(game.streak, 10))
  floatOverPet(`+${got} 💎`)
  unlock('first_task')
  if (game.total >= 10) unlock('tasks10')
  if (game.total >= 50) unlock('tasks50')
  if (game.streak >= 5) unlock('streak5')
  if (game.streak >= 10) unlock('streak10')
  checkQuests()
  saveGame()
  renderGame()
  bouncePet()
  spawnCoinBurst(10) // a real on-chain job settled — coins burst in the scene
}

function onTaskFail() {
  rollDay()
  if (game.streak >= 2 && game.shields > 0) {
    // Combo shield: one bought insurance eats the failure, streak survives.
    game.shields -= 1
    showToast(lang === 'ko' ? `🛡️ 콤보 보호! 연속 ${game.streak} 유지 (남은 보호 ${game.shields})` : `🛡️ Combo shielded! Streak of ${game.streak} survives (${game.shields} left)`)
  } else {
    game.streak = 0
  }
  addXp(1) // consolation XP — the model did try
  gainShards(1)
  saveGame()
  renderGame()
}

/** Small floating reward text rising off the pet — the juice that makes
 *  earning feel like earning. */
function floatOverPet(text) {
  const wrap = document.getElementById('pet-wrap')
  if (!wrap) return
  const el = document.createElement('span')
  el.className = 'float-reward'
  el.textContent = text
  wrap.appendChild(el)
  setTimeout(() => el.remove(), 1100)
}

let lastPetClick = 0

function onPetClick() {
  const now = Date.now()
  if (now - lastPetClick < 1500) return // petting cooldown
  lastPetClick = now
  rollDay()
  game.clicksToday += 1
  const got = gainShards(1)
  floatOverPet(`+${got} 💎`)
  bouncePet()
  checkQuests()
  saveGame()
  renderGame()
}

function checkQuests() {
  rollDay()
  for (const q of QUESTS) {
    if (game.questsClaimed.includes(q.id)) continue
    if (q.progress(game) >= q.goal) {
      game.questsClaimed.push(q.id)
      game.shards += q.reward // quest rewards skip the magnet — fixed prizes
      const name = lang === 'ko' ? q.ko : q.en
      showToast(lang === 'ko' ? `📜 퀘스트 완료: ${name} +${q.reward}💎` : `📜 Quest complete: ${name} +${q.reward}💎`)
    }
  }
}

function buy(kind, id) {
  rollDay()
  if (kind === 'upgrade') {
    const def = UPGRADES.find((u) => u.id === id)
    const tier = game.upgrades[id] ?? 0
    if (tier >= def.max) return
    const cost = def.cost(tier)
    if (game.shards < cost) return
    game.shards -= cost
    game.upgrades[id] = tier + 1
  } else if (kind === 'shield') {
    if (game.shields >= SHIELD.max || game.shards < SHIELD.cost) return
    game.shards -= SHIELD.cost
    game.shields += 1
  } else if (kind === 'hat') {
    const def = HATS.find((h) => h.id === id)
    if (game.hats.includes(id)) {
      game.hat = game.hat === id ? null : id // owned: click toggles wearing it
    } else {
      if (game.shards < def.cost) return
      game.shards -= def.cost
      game.hats.push(id)
      game.hat = id
    }
  } else if (kind === 'reflex') {
    const tier = reflexTier()
    if (tier >= REFLEX_MAX) return
    const cost = reflexCost(tier)
    if (game.shards < cost) return
    game.shards -= cost
    game.drones = tier + 1
    applyReflex() // actually retune the Rust miner's poll cadence — REAL
    spawnDrone() // one more drone orbits, visualizing the faster reflex
  } else if (kind === 'lane') {
    if (id === 'image') {
      game.lanes.image = !game.lanes.image
    } else if (id === 'audio') {
      if (!game.lanes.audioUnlocked) {
        if (game.shards < AUDIO_LANE_COST) return
        game.shards -= AUDIO_LANE_COST
        game.lanes.audioUnlocked = true
        game.lanes.audio = true
        unlock('audio_lane')
      } else {
        game.lanes.audio = !game.lanes.audio
      }
    }
    applyLanes() // declare capabilities to the platform — REAL job matching
    const box = document.getElementById('image-mining-toggle')
    if (box) box.checked = game.lanes.image
  }
  saveGame()
  renderGame()
}

/** Push the enabled lanes to the platform as declared capabilities. The
 *  miner only ever declares what it can genuinely fulfill (image gen, TTS). */
function applyLanes() {
  invoke('set_lanes', { image: game.lanes.image, audio: game.lanes.audio }).catch((e) => {
    // revert optimistic state if the platform rejects the update
    appendLog(`Lane update failed: ${e}`)
  })
}

// ---------- Lane model / voice pickers ----------
//
// Each generation lane can pick WHICH model/voice it uses, not just on/off:
// image jobs → a pollinations image model, audio jobs → a TTS voice/language.

let imageModelsLoaded = false

async function loadImageModelOptions() {
  const sel = document.getElementById('image-model-select')
  if (!sel || imageModelsLoaded) return
  try {
    const models = await invoke('list_image_models')
    for (const m of models) {
      const o = document.createElement('option')
      o.value = m
      o.textContent = m
      sel.appendChild(o)
    }
    if (sel.dataset.saved) sel.value = sel.dataset.saved
    imageModelsLoaded = true
  } catch (e) {
    appendLog(`Image model list unavailable: ${e}`)
  }
}

function updateLaneModelRows() {
  const imgRow = document.getElementById('image-model-row')
  const audRow = document.getElementById('audio-voice-row')
  if (imgRow) imgRow.hidden = !game.lanes.image
  if (audRow) audRow.hidden = !game.lanes.audio
  if (game.lanes.image) loadImageModelOptions()
}

function saveLaneModels() {
  const imageModel = document.getElementById('image-model-select').value
  const audioVoice = document.getElementById('audio-voice-select').value
  invoke('save_lane_models', { imageModel, audioVoice }).catch((e) => appendLog(`Saving model choice failed: ${e}`))
}

/** Graduate the buddy: a game-layer reset for a permanent 💎/XP multiplier,
 *  GATED on real cumulative completed jobs. Keeps everything REAL (reflex,
 *  lanes, lifetime job count, cosmetics) — only the grind layer resets. */
function doPrestige() {
  if (!canPrestige()) return
  game.prestige = (game.prestige || 0) + 1
  game.level = 1
  game.xp = 0
  game.shards = 0
  game.upgrades = { xp: 0, magnet: 0 }
  game.shields = 0
  unlock('prestige1')
  showToast(lang === 'ko'
    ? `⭐ 프레스티지! 이제 ×${game.prestige} — 💎·XP 영구 +${(game.prestige * 25)}%`
    : `⭐ Prestige ×${game.prestige}! Permanent +${game.prestige * 25}% 💎 & XP`)
  saveGame()
  renderGame()
}

function renderGame() {
  const panel = document.getElementById('game-panel')
  if (!panel) return
  rollDay()
  document.getElementById('pet-sprite').textContent = petForLevel(game.level)
  document.getElementById('pet-level').textContent = `Lv.${game.level}` + (game.prestige ? ` ⭐${game.prestige}` : '')
  document.getElementById('shard-count').textContent = String(game.shards)

  const hatEl = document.getElementById('pet-hat')
  const hatDef = HATS.find((h) => h.id === game.hat)
  hatEl.hidden = !hatDef
  hatEl.textContent = hatDef ? hatDef.emoji : ''

  const streakEl = document.getElementById('pet-streak')
  streakEl.hidden = game.streak < 2
  streakEl.textContent = `🔥×${game.streak}` + (game.shields > 0 ? ` 🛡️×${game.shields}` : '')

  const need = xpNeeded(game.level)
  document.getElementById('xp-fill').style.width = `${Math.min(100, (game.xp / need) * 100)}%`
  document.getElementById('xp-text').textContent = `${game.xp} / ${need} XP`

  renderQuests()
  renderShop()

  const badges = document.getElementById('badges')
  badges.innerHTML = ''
  for (const a of ACHIEVEMENTS) {
    const span = document.createElement('span')
    const unlocked = Boolean(game.ach[a.id])
    span.className = unlocked ? 'badge' : 'badge locked'
    span.textContent = a.emoji
    span.title = lang === 'ko' ? a.ko : a.en
    badges.appendChild(span)
  }
}

function renderQuests() {
  const wrap = document.getElementById('quests')
  wrap.innerHTML = ''
  for (const q of QUESTS) {
    const done = game.questsClaimed.includes(q.id)
    const cur = Math.min(q.progress(game), q.goal)
    const line = document.createElement('div')
    line.className = done ? 'quest done' : 'quest'
    line.textContent = `${done ? '✅' : '⬜'} ${lang === 'ko' ? q.ko : q.en} — ${cur}/${q.goal} (+${q.reward}💎)`
    wrap.appendChild(line)
  }
}

function shopRow(labelText, note, canBuy, onClick) {
  const row = document.createElement('div')
  row.className = 'shop-row'
  const label = document.createElement('span')
  label.textContent = labelText
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'shop-buy'
  btn.textContent = note
  btn.disabled = !canBuy
  btn.addEventListener('click', onClick)
  row.appendChild(label)
  row.appendChild(btn)
  return row
}

function renderShop() {
  const shop = document.getElementById('shop')
  if (shop.hidden) return
  shop.innerHTML = ''
  const ko = lang === 'ko'

  // Reflex training — the REAL throughput upgrade. Retunes the miner's poll
  // cadence, so it grabs real jobs faster (more real USDC/day).
  {
    const tier = reflexTier()
    const maxed = tier >= REFLEX_MAX
    const cur = pollSecsForTier(tier)
    const next = pollSecsForTier(tier + 1)
    shop.appendChild(shopRow(
      `⚡ ${ko ? '반사신경 훈련' : 'Reflex training'} T${tier}/${REFLEX_MAX} (${ko ? `폴 ${cur}초` : `poll ${cur}s`}${maxed ? '' : ` → ${next}초`})`,
      maxed ? (ko ? '최대' : 'MAX') : `${reflexCost(tier)}💎`,
      !maxed && game.shards >= reflexCost(tier),
      () => buy('reflex'),
    ))
  }

  for (const u of UPGRADES) {
    const tier = game.upgrades[u.id] ?? 0
    const maxed = tier >= u.max
    shop.appendChild(shopRow(
      `${u.emoji} ${ko ? u.ko : u.en} ${tier}/${u.max} (${u.bonus})`,
      maxed ? (ko ? '최대' : 'MAX') : `${u.cost(tier)}💎`,
      !maxed && game.shards >= u.cost(tier),
      () => buy('upgrade', u.id),
    ))
  }

  shop.appendChild(shopRow(
    `🛡️ ${ko ? '콤보 보호막 (실패 1회 무효)' : 'Combo shield (absorbs one failure)'} ${game.shields}/${SHIELD.max}`,
    game.shields >= SHIELD.max ? (ko ? '최대' : 'MAX') : `${SHIELD.cost}💎`,
    game.shields < SHIELD.max && game.shards >= SHIELD.cost,
    () => buy('shield'),
  ))

  // ── Real deliverable lanes (declared capabilities → real job matching) ──
  shop.appendChild(shopRow(
    `🖼️ ${ko ? '이미지 레인 (보수 높음)' : 'Image lane (higher pay)'}`,
    game.lanes.image ? (ko ? '켜짐 · 끄기' : 'ON · turn off') : (ko ? '켜기' : 'Turn on'),
    true,
    () => buy('lane', 'image'),
  ))
  shop.appendChild(shopRow(
    `🎧 ${ko ? '오디오 레인 (TTS 내레이션)' : 'Audio lane (TTS narration)'}`,
    !game.lanes.audioUnlocked
      ? `${AUDIO_LANE_COST}💎`
      : game.lanes.audio ? (ko ? '켜짐 · 끄기' : 'ON · turn off') : (ko ? '켜기' : 'Turn on'),
    game.lanes.audioUnlocked || game.shards >= AUDIO_LANE_COST,
    () => buy('lane', 'audio'),
  ))

  for (const h of HATS) {
    const owned = game.hats.includes(h.id)
    const wearing = game.hat === h.id
    shop.appendChild(shopRow(
      `${h.emoji} ${ko ? '모자' : 'Hat'}${wearing ? (ko ? ' (착용 중)' : ' (wearing)') : ''}`,
      owned ? (wearing ? (ko ? '벗기' : 'Take off') : (ko ? '착용' : 'Wear')) : `${h.cost}💎`,
      owned || game.shards >= h.cost,
      () => buy('hat', h.id),
    ))
  }

  // ── Prestige (game-layer meta, GATED ON REAL completed jobs) ──
  {
    const need = prestigeReq(game.prestige || 0)
    const have = game.total || 0
    const ready = canPrestige()
    shop.appendChild(shopRow(
      `⭐ ${ko ? '프레스티지' : 'Prestige'} ×${game.prestige || 0} (${ko ? '실적 잡' : 'real jobs'} ${Math.min(have, need)}/${need} → 💎·XP +25%)`,
      ready ? (ko ? '졸업!' : 'Graduate!') : (ko ? `${need - have}건 더` : `${need - have} more`),
      ready,
      () => { if (confirm(ko ? '레벨·💎·업그레이드를 리셋하고 영구 +25% 배수를 얻습니다. 반사신경·레인·실적은 유지돼요. 진행할까요?' : 'Reset level/💎/upgrades for a permanent +25% multiplier. Reflex, lanes and real record are kept. Proceed?')) doPrestige() },
    ))
  }
}

/** "Welcome back" summary — the idle-game payoff moment. Balance is real
 *  (from the platform), so the number is honest. */
let awayChecked = false

function checkAwayEarnings(usdc) {
  if (awayChecked) return
  awayChecked = true
  const seen = game.lastSeen
  if (seen && typeof seen.usdc === 'number' && Date.now() - seen.at > 30 * 60_000) {
    const delta = usdc - seen.usdc
    if (delta > 0.005) {
      showToast(lang === 'ko'
        ? `⛏️ 자리 비운 동안 $${delta.toFixed(2)} 벌었어요!`
        : `⛏️ Your miner earned $${delta.toFixed(2)} while you were away!`)
    }
  }
}

// Wire real stat deltas into the game. Counters come from the Rust mining
// loop as running totals per app run, so we diff against the last seen
// values (and re-sync if they ever go backwards, e.g. after a restart).
let prevCompleted = null
let prevFailed = null

function gameOnStatus(completed, failed) {
  if (prevCompleted === null) {
    prevCompleted = completed
    prevFailed = failed
    return
  }
  if (completed < prevCompleted || failed < prevFailed) {
    prevCompleted = completed
    prevFailed = failed
    return
  }
  for (let i = prevCompleted; i < completed; i++) onTaskDone()
  for (let i = prevFailed; i < failed; i++) onTaskFail()
  prevCompleted = completed
  prevFailed = failed
}

function gameOnWallet(usdc) {
  if (usdc >= 1) unlock('dollar1')
  if (usdc >= 10) unlock('dollar10')
  checkAwayEarnings(usdc)
  noteEarnings(usdc) // feed the REAL $/day readout
  game.lastSeen = { usdc, at: Date.now() }
  saveGame()
}

function gameOnCredit(rating) {
  if (typeof rating === 'string' && rating.startsWith('A')) unlock('credit_a')
}

// ---------- Idle economy + canvas Mining World ----------
//
// The scene is a real idle game: drones you buy produce 💎 over time, the
// buddy swings harder while a real job is running, and completed on-chain
// jobs burst coins. Everything visual is game-layer (💎 shards, never USDC);
// the honest numbers (USDC, credit) stay in the dashboard tiles.

let worldRAF = null
let worldLast = 0
let miningActive = false
const coins = []   // {x,y,vx,vy,life}
const motes = []   // ambient rising 💎 {x,y,vy,life,size}
const drones = []  // {a, r, bob, phase}  orbiting auto-miners
let swing = 0      // pickaxe swing phase

function spawnDrone() {
  drones.push({ a: Math.random() * Math.PI * 2, r: 0, bob: Math.random() * Math.PI * 2, phase: Math.random() })
}

function spawnCoinBurst(n = 8) {
  const c = document.getElementById('mine-canvas')
  if (!c) return
  const cx = c.clientWidth / 2, cy = c.clientHeight * 0.62
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6
    const sp = 1.6 + Math.random() * 2.2
    coins.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1.5, life: 1 })
  }
}

/** Push the current reflex tier's poll cadence into the Rust miner — this is
 *  the REAL effect. Also migrates veterans (lots of real jobs, no reflex yet)
 *  up a few tiers so the upgrade never nerfs an existing miner. */
function applyReflex() {
  // one-time migration: reward past real work with starter reflexes
  const earned = Math.min(REFLEX_MAX, Math.floor((game.total || 0) / 4))
  if ((game.drones || 0) < earned) game.drones = earned
  const secs = pollSecsForTier(reflexTier())
  invoke('set_poll_interval', { secs }).catch(() => {})
  saveGame()
  updateRateHud()
}

// Real earnings rate: sampled from actual wallet balance over the session.
const earnStat = { startUsd: null, startAt: 0, lastUsd: null }
function noteEarnings(usdc) {
  if (earnStat.startUsd === null) { earnStat.startUsd = usdc; earnStat.startAt = Date.now() }
  earnStat.lastUsd = usdc
  updateRateHud()
}
function projectedPerDay() {
  if (earnStat.startUsd === null) return null
  const days = (Date.now() - earnStat.startAt) / 86_400_000
  if (days < 0.0007) return null // < ~1 min of data → not enough to project
  const delta = (earnStat.lastUsd ?? earnStat.startUsd) - earnStat.startUsd
  return delta / days
}

let idleSaveCtr = 0
function idleTick() {
  // No fake currency is produced here — 💎 only come from real completed
  // jobs. This tick just keeps the live rate readout honest.
  game.lastTick = Date.now()
  if (++idleSaveCtr % 15 === 0) saveGame()
  updateRateHud()
}

function updateRateHud() {
  const el = document.getElementById('idle-rate')
  if (!el) return
  const secs = pollSecsForTier(reflexTier())
  const perDay = projectedPerDay()
  const ko = lang === 'ko'
  const rate = perDay === null
    ? (ko ? '측정 중…' : 'measuring…')
    : `~$${perDay.toFixed(2)}/${ko ? '일' : 'day'}`
  el.textContent = `⚡ ${ko ? '폴' : 'poll'} ${secs}s · ${rate}`
}

function renderWorld(ts) {
  const c = document.getElementById('mine-canvas')
  if (!c) { worldRAF = null; return }
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = c.clientWidth, h = c.clientHeight
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
  const ctx = c.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const dt = Math.min((ts - worldLast) || 16, 50) / 16
  worldLast = ts

  // cavern backdrop
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#0e1526'); g.addColorStop(1, '#070b14')
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = 0.5
  for (let i = 0; i < 22; i++) {
    const x = (i * 53.3 % w), y = (i * 71.7 % (h * 0.9)) + 6
    ctx.fillStyle = i % 3 ? '#1b2740' : '#242f4d'
    ctx.beginPath(); ctx.arc(x, y, 1.5 + (i % 3), 0, 7); ctx.fill()
  }
  ctx.globalAlpha = 1

  const cx = w / 2, groundY = h * 0.78
  // ground line
  ctx.strokeStyle = '#243154'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(w, groundY); ctx.stroke()

  // ore vein (pulses) — the thing being mined
  const pulse = 0.6 + 0.4 * Math.sin(ts / 380)
  ctx.font = '26px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.globalAlpha = pulse; ctx.fillText('💎', cx + 54, groundY - 12); ctx.globalAlpha = 1
  ctx.fillText('🪨', cx + 40, groundY + 4)

  // ambient motes
  if (Math.random() < 0.06 + game.drones * 0.02) motes.push({ x: cx + (Math.random() - 0.5) * 90, y: groundY, vy: 0.3 + Math.random() * 0.5, life: 1, size: 10 + Math.random() * 8 })
  for (let i = motes.length - 1; i >= 0; i--) {
    const m = motes[i]; m.y -= m.vy * dt; m.life -= 0.012 * dt
    if (m.life <= 0) { motes.splice(i, 1); continue }
    ctx.globalAlpha = Math.max(0, m.life) * 0.8; ctx.font = `${m.size}px serif`; ctx.fillText('💎', m.x, m.y)
  }
  ctx.globalAlpha = 1

  // the buddy — bobbing, with pickaxe. swing speed rises while mining.
  const bob = Math.sin(ts / 500) * 4
  const petY = groundY - 26 + bob
  swing += dt * (miningActive ? 0.34 : 0.14)
  ctx.font = '42px serif'
  ctx.fillText(petForLevel(game.level), cx, petY)
  const hat = HATS.find((x) => x.id === game.hat)
  if (hat) { ctx.font = '22px serif'; ctx.fillText(hat.emoji, cx, petY - 26) }
  // pickaxe swinging next to the buddy
  ctx.save(); ctx.translate(cx + 26, petY + 6); ctx.rotate(Math.sin(swing) * 0.7 - 0.3)
  ctx.font = '26px serif'; ctx.fillText('⛏️', 0, 0); ctx.restore()
  // spark when the pickaxe hits (bottom of swing) while actively mining
  if (miningActive && Math.sin(swing) > 0.96 && Math.random() < 0.5) {
    coins.push({ x: cx + 40, y: petY, vx: (Math.random() - 0.5) * 1.5, vy: -1 - Math.random(), life: 0.6, spark: true })
  }

  // orbiting drones
  for (const d of drones) {
    d.a += 0.008 * dt; d.r += (74 - d.r) * 0.04
    d.bob += 0.05 * dt
    const dx = cx + Math.cos(d.a) * d.r, dy = petY - 6 + Math.sin(d.a) * d.r * 0.5 + Math.sin(d.bob) * 3
    ctx.font = '20px serif'; ctx.fillText('🛸', dx, dy)
    if (Math.random() < 0.02) motes.push({ x: dx, y: dy, vy: 0.4, life: 1, size: 9 })
  }

  // coins / sparks
  for (let i = coins.length - 1; i >= 0; i--) {
    const p = coins[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 0.14 * dt; p.life -= 0.02 * dt
    if (p.life <= 0) { coins.splice(i, 1); continue }
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5))
    ctx.font = `${p.spark ? 14 : 20}px serif`; ctx.fillText(p.spark ? '✨' : '🪙', p.x, p.y)
  }
  ctx.globalAlpha = 1

  worldRAF = requestAnimationFrame(renderWorld)
}

function startIdleWorld() {
  applyReflex() // migrate veterans + push the saved reflex cadence to Rust
  applyLanes() // re-declare saved deliverable lanes to the platform on launch
  // seed drone sprites to match the reflex tier (visual of trained reflexes)
  drones.length = 0
  for (let i = 0; i < reflexTier(); i++) spawnDrone()
  updateRateHud()
  if (!startIdleWorld._tick) startIdleWorld._tick = setInterval(idleTick, 1000)
  if (!worldRAF) { worldLast = performance.now(); worldRAF = requestAnimationFrame(renderWorld) }
}

// ---------- Step 3: mining dashboard ----------

function backendLabel(backend) {
  if (backend.kind === 'ollama') return `${backend.model} via Ollama`
  return `${backend.model} via ${backend.base_url}`
}

function appendLog(line) {
  const log = document.getElementById('log')
  const stamp = new Date().toLocaleTimeString()
  log.textContent += `[${stamp}] ${line}\n`
  log.scrollTop = log.scrollHeight
}

function onMiningEvent(payload) {
  if (payload.type === 'Log') {
    appendLog(payload.line)
  } else if (payload.type === 'Status') {
    const badge = document.getElementById('status-badge')
    badge.textContent = payload.state
    badge.dataset.state = payload.state
    setText('stat-completed', String(payload.tasks_completed))
    setText('stat-failed', String(payload.tasks_failed))
    gameOnStatus(payload.tasks_completed, payload.tasks_failed)

    const running = payload.state === 'polling' || payload.state === 'running' || payload.state === 'warming'
    document.getElementById('start-btn').hidden = running
    document.getElementById('stop-btn').hidden = !running
    // buddy swings hard while a real job is executing
    miningActive = payload.state === 'running' || payload.state === 'warming'
  }
}

let walletTimer = null

async function refreshWallet() {
  try {
    const w = await invoke('get_wallet')
    const el = document.getElementById('stat-balance')
    if (w.usdc === null || w.usdc === undefined) {
      el.textContent = '—'
    } else {
      el.textContent = `$${w.usdc.toFixed(2)}`
      gameOnWallet(w.usdc)
    }
  } catch {
    /* wallet not provisioned yet or offline — leave the dash */
  }
  try {
    const card = await invoke('get_agent_card')
    document.getElementById('stat-credit').textContent = `${card.credit_score} · ${card.credit_rating}`
    gameOnCredit(card.credit_rating)
  } catch {
    /* card unavailable — leave the dash */
  }
}

// ---------- Delegation (requester side) ----------

let currentPlanId = null
let delegateTimer = null
let govTimer = null
let govPrevReviews = 0

function delegateMsg(okText, errText) {
  const ok = document.getElementById('delegate-ok')
  const err = document.getElementById('delegate-error')
  ok.hidden = !okText
  ok.textContent = okText || ''
  err.hidden = !errText
  err.textContent = errText || ''
}

const JOB_STATUS_ICON = {
  Open: '🕐', Claimed: '⚙️', Submitted: '📤', Completed: '✅', Refunded: '↩️', Disputed: '⚠️',
}

// Deliverable-kind glyph — shown per subtask so the requester sees at a glance
// whether a node produces text, an image, or audio.
const DELIVERABLE_ICON = { text: '📝', image: '🖼️', audio: '🎧', video: '🎬', file: '📎' }

// Platform origin for artifact links (final outputs embed relative
// /api/artifacts/<id> URLs; in the Tauri webview they need an absolute base).
let platformBase = ''

/** Render an assembled delegation output into `container`: markdown image
 *  links (`![name](/api/artifacts/id)`) become <img>, audio artifact links
 *  become <audio>, everything else stays as text. Keeps the requester's
 *  result visual instead of a wall of markdown. */
function renderDelegationOutput(container, text) {
  container.innerHTML = ''
  const abs = (u) => (u.startsWith('http') ? u : `${platformBase}${u}`)
  // Split on any markdown link that points at an artifact (image or file form).
  const re = /(!?)\[([^\]]*)\]\((\/api\/artifacts\/[^)\s]+|https?:\/\/[^)\s]+)\)/g
  let last = 0, m
  const pushText = (s) => { if (s) container.appendChild(document.createTextNode(s)) }
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index))
    last = re.lastIndex
    const [, bang, name, url] = m
    const isImage = bang === '!' || /\.(png|jpe?g|webp|gif)$/i.test(name) || /\.(png|jpe?g|webp|gif)$/i.test(url)
    const isAudio = /\.(mp3|wav|ogg|webm|m4a)$/i.test(name) || /\.(mp3|wav|ogg|webm|m4a)$/i.test(url)
    if (isImage) {
      const img = document.createElement('img')
      img.className = 'dlg-media'
      img.loading = 'lazy'
      img.alt = name || 'image'
      img.src = abs(url)
      container.appendChild(img)
    } else if (isAudio) {
      const audio = document.createElement('audio')
      audio.className = 'dlg-media'
      audio.controls = true
      audio.preload = 'none'
      audio.src = abs(url)
      container.appendChild(audio)
    } else {
      const a = document.createElement('a')
      a.href = '#'
      a.textContent = name || url
      a.addEventListener('click', (e) => { e.preventDefault(); invoke('open_url', { url: abs(url) }).catch(() => {}) })
      container.appendChild(a)
    }
  }
  pushText(text.slice(last))
}

function renderPlanReview(subtasks) {
  const list = document.getElementById('delegate-plan-list')
  list.innerHTML = ''
  for (const st of subtasks) {
    const li = document.createElement('li')
    const kind = DELIVERABLE_ICON[st.deliverableKind || 'text'] || '📝'
    li.textContent = `${kind} $${Number(st.bountyUsd).toFixed(2)} — ${st.title}`
    li.title = st.description
    list.appendChild(li)
  }
  document.getElementById('delegate-plan-review').hidden = false
}

function renderDelegations(delegations) {
  const wrap = document.getElementById('delegate-list')
  wrap.innerHTML = ''
  for (const d of delegations) {
    if (d.status === 'planned' && d.id !== currentPlanId) continue // stale unconfirmed plans from other sessions
    const card = document.createElement('div')
    card.className = 'dlg-card'

    const head = document.createElement('div')
    head.className = 'dlg-head'
    const statusKo = { planned: '계획됨', posted: '진행 중', completed: '완료', failed: '실패' }
    const label = lang === 'ko' ? (statusKo[d.status] || d.status) : d.status
    head.innerHTML = `<span class="dlg-status dlg-${d.status}">${label}</span> <span class="dlg-budget">$${d.budget_usd.toFixed(2)}</span>`
    card.appendChild(head)

    const task = document.createElement('div')
    task.className = 'dlg-task'
    task.textContent = d.task.length > 120 ? d.task.slice(0, 120) + '…' : d.task
    card.appendChild(task)

    if (d.status !== 'planned') {
      for (const st of d.subtasks) {
        const line = document.createElement('div')
        line.className = 'dlg-subtask'
        const icon = st.failed ? '❌' : (JOB_STATUS_ICON[st.jobStatus] || '🕐')
        const kind = DELIVERABLE_ICON[st.deliverableKind || 'text'] || '📝'
        const worker = st.workerLabel ? ` · ${st.workerLabel}` : ''
        line.textContent = `${icon} ${kind} ${st.title} — $${Number(st.bountyUsd).toFixed(2)}${worker}`
        card.appendChild(line)
      }
    }

    if (d.final_output) {
      const det = document.createElement('details')
      const sum = document.createElement('summary')
      sum.textContent = lang === 'ko' ? '최종 결과물 보기' : 'View final output'
      const pre = document.createElement('pre')
      pre.className = 'dlg-output'
      // Render embedded image/audio artifacts as media, not raw markdown.
      renderDelegationOutput(pre, d.final_output)
      det.appendChild(sum)
      det.appendChild(pre)
      card.appendChild(det)
    }
    if (d.error) {
      const err = document.createElement('div')
      err.className = 'error'
      err.textContent = d.error
      card.appendChild(err)
    }
    wrap.appendChild(card)
  }
}

async function refreshDelegations() {
  try {
    const res = await invoke('delegation_status')
    renderDelegations(res.delegations || [])
  } catch {
    /* offline or platform hiccup — keep the last rendering */
  }
}

function initDelegateView() {
  const section = document.getElementById('delegate-section')

  // Poll only while the panel is open — each poll also drives the
  // platform's verification tick, so an open panel IS the heartbeat.
  section.addEventListener('toggle', () => {
    if (section.open) {
      refreshDelegations()
      if (!delegateTimer) delegateTimer = setInterval(refreshDelegations, 12_000)
    } else if (delegateTimer) {
      clearInterval(delegateTimer)
      delegateTimer = null
    }
  })

  document.getElementById('delegate-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    delegateMsg('', '')
    const btn = document.getElementById('delegate-plan-btn')
    btn.disabled = true
    try {
      const goal = document.getElementById('delegate-goal').value.trim()
      const budgetUsd = Number(document.getElementById('delegate-budget').value)
      const password = document.getElementById('delegate-password').value
      const res = await invoke('plan_delegation', { goal, budgetUsd, password })
      currentPlanId = res.id
      renderPlanReview(res.subtasks || [])
    } catch (err) {
      delegateMsg('', String(err))
    } finally {
      btn.disabled = false
    }
  })

  document.getElementById('delegate-confirm-btn').addEventListener('click', async () => {
    if (!currentPlanId) return
    delegateMsg('', '')
    const btn = document.getElementById('delegate-confirm-btn')
    btn.disabled = true
    try {
      const password = document.getElementById('delegate-password').value
      const res = await invoke('confirm_delegation', { id: currentPlanId, password })
      document.getElementById('delegate-plan-review').hidden = true
      document.getElementById('delegate-goal').value = ''
      delegateMsg(lang === 'ko' ? `하위 작업 ${res.posted}건 게시 완료 — 아래에서 진행 상황을 확인하세요.` : `Posted ${res.posted} subtasks — track progress below.`, '')
      currentPlanId = null
      refreshDelegations()
    } catch (err) {
      delegateMsg('', String(err))
    } finally {
      btn.disabled = false
    }
  })

  document.getElementById('delegate-discard-btn').addEventListener('click', async () => {
    if (!currentPlanId) return
    try {
      const password = document.getElementById('delegate-password').value
      await invoke('discard_delegation', { id: currentPlanId, password })
    } catch { /* already gone is fine */ }
    currentPlanId = null
    document.getElementById('delegate-plan-review').hidden = true
    refreshDelegations()
  })
}

// ---------- Governance ($LEDGER) ----------

function govMsg(okText, errText) {
  const okEl = document.getElementById('gov-ok')
  const errEl = document.getElementById('gov-error')
  okEl.hidden = !okText
  okEl.textContent = okText || ''
  errEl.hidden = !errText
  errEl.textContent = errText || ''
}

async function gov(action, args = {}) {
  return invoke('governance', { action, args })
}

function renderGovernance(data) {
  const s = data.summary || {}
  setText('gov-power', (s.votingPower ?? 0).toFixed(1))
  setText('gov-balance', (s.balance ?? 0).toFixed(1))
  setText('gov-locked', (s.locked ?? 0).toFixed(1))
  setText('gov-earned', (s.totalEarned ?? 0).toFixed(1))

  // This agent's delegate config (only if the platform sent it — i.e. this
  // agent exists in the owner's roster).
  const dWrap = document.getElementById('gov-delegate')
  const me = data.me
  if (me) {
    dWrap.hidden = false
    const toggle = document.getElementById('gov-autovote-toggle')
    const policy = document.getElementById('gov-policy')
    toggle.checked = Boolean(me.autoVote)
    if (document.activeElement !== policy) policy.value = me.votePolicy || ''
  } else {
    dWrap.hidden = true
  }

  // Pending delegate reviews — the human-in-the-loop queue.
  const reviews = data.reviews || []
  const rWrap = document.getElementById('gov-reviews')
  rWrap.textContent = ''
  if (reviews.length > govPrevReviews && govPrevReviews >= 0) {
    const msg = lang === 'ko'
      ? `🔍 대리인이 판단을 요청한 안건 ${reviews.length}건 — 확인해줘`
      : `🔍 ${reviews.length} vote(s) need your review`
    showToast(msg)
    appendLog(msg)
  }
  govPrevReviews = reviews.length
  for (const r of reviews) {
    const card = document.createElement('div')
    card.className = 'gov-review-card'
    const head = document.createElement('div')
    head.className = 'gov-review-head'
    const title = document.createElement('strong')
    title.textContent = r.proposalTitle
    const rec = document.createElement('span')
    rec.className = 'gov-rec'
    rec.textContent = `→ ${r.choice}${r.confidence != null ? ` · ${Math.round(r.confidence * 100)}%` : ''}`
    head.append(title, rec)
    card.appendChild(head)
    if (r.reason) {
      const reason = document.createElement('p')
      reason.className = 'gov-reason'
      reason.textContent = `⚠ ${r.reason}`
      card.appendChild(reason)
    }
    if (r.rationale) {
      const rat = document.createElement('p')
      rat.className = 'gov-rationale'
      rat.textContent = `🤖 ${r.rationale}`
      card.appendChild(rat)
    }
    const actions = document.createElement('div')
    actions.className = 'gov-review-actions'
    const accept = document.createElement('button')
    accept.textContent = lang === 'ko' ? `${r.choice} 투표` : `Vote ${r.choice}`
    accept.addEventListener('click', () => resolveGovReview(r.proposalId, 'accept'))
    const dismiss = document.createElement('button')
    dismiss.className = 'link-btn'
    dismiss.textContent = lang === 'ko' ? '무시' : 'Dismiss'
    dismiss.addEventListener('click', () => resolveGovReview(r.proposalId, 'dismiss'))
    actions.append(accept, dismiss)
    card.appendChild(actions)
    rWrap.appendChild(card)
  }

  // Open proposals with vote buttons.
  const props = data.proposals || []
  const pWrap = document.getElementById('gov-proposals')
  pWrap.textContent = ''
  const open = props.filter((p) => p.open)
  if (open.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hint'
    empty.textContent = lang === 'ko' ? '열린 안건이 없어요.' : 'No open proposals.'
    pWrap.appendChild(empty)
  }
  for (const p of open) {
    const card = document.createElement('div')
    card.className = 'gov-prop-card'
    const title = document.createElement('strong')
    title.textContent = p.title
    card.appendChild(title)
    const t = p.tally || {}
    const tallyLine = document.createElement('p')
    tallyLine.className = 'gov-tally'
    tallyLine.textContent = `For ${(t.for ?? 0).toFixed(1)} · Against ${(t.against ?? 0).toFixed(1)} · Abstain ${(t.abstain ?? 0).toFixed(1)}`
    card.appendChild(tallyLine)
    if (p.yourVote) {
      const yv = document.createElement('p')
      yv.className = 'gov-yourvote'
      yv.textContent = (lang === 'ko' ? '내 투표: ' : 'You voted: ') + p.yourVote
      card.appendChild(yv)
    } else {
      const actions = document.createElement('div')
      actions.className = 'gov-vote-actions'
      for (const c of ['for', 'against', 'abstain']) {
        const btn = document.createElement('button')
        btn.textContent = c
        btn.addEventListener('click', () => castGovVote(p.id, c))
        actions.appendChild(btn)
      }
      card.appendChild(actions)
    }
    pWrap.appendChild(card)
  }
}

async function refreshGovernance() {
  try {
    const data = await gov('view')
    renderGovernance(data)
  } catch {
    /* offline or migration pending — keep last rendering */
  }
}

async function castGovVote(proposalId, choice) {
  govMsg('', '')
  try {
    await gov('vote', { proposal_id: proposalId, choice })
    unlock('first_vote')
    addXp(15)
    const got = gainShards(8)
    floatOverPet(`+${got} 💎`)
    saveGame()
    renderGame()
    govMsg(lang === 'ko' ? `투표 완료: ${choice}` : `Voted ${choice}`, '')
    refreshGovernance()
  } catch (err) {
    govMsg('', String(err))
  }
}

async function resolveGovReview(proposalId, decision) {
  govMsg('', '')
  try {
    const r = await gov('review', { proposal_id: proposalId, decision })
    if (decision === 'accept' && r.cast) {
      unlock('first_vote')
      addXp(15)
      saveGame()
      renderGame()
    }
    refreshGovernance()
  } catch (err) {
    govMsg('', String(err))
  }
}

function initGovernanceView() {
  const section = document.getElementById('governance-section')
  section.addEventListener('toggle', () => {
    if (section.open) {
      govPrevReviews = -1 // suppress the toast on the very first load
      refreshGovernance()
      if (!govTimer) govTimer = setInterval(refreshGovernance, 30_000)
    } else if (govTimer) {
      clearInterval(govTimer)
      govTimer = null
    }
  })

  document.getElementById('gov-lock-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    govMsg('', '')
    const amount = Number(document.getElementById('gov-lock-amount').value)
    const weeks = Number(document.getElementById('gov-lock-weeks').value)
    try {
      await gov('lock', { amount, weeks })
      unlock('first_lock')
      addXp(20)
      const got = gainShards(10)
      floatOverPet(`+${got} 💎`)
      saveGame()
      renderGame()
      document.getElementById('gov-lock-amount').value = ''
      govMsg(lang === 'ko' ? `${amount} $LEDGER를 ${weeks}주 잠갔어요` : `Locked ${amount} $LEDGER for ${weeks}w`, '')
      refreshGovernance()
    } catch (err) {
      govMsg('', String(err))
    }
  })

  document.getElementById('gov-autovote-toggle').addEventListener('change', async (e) => {
    const box = e.target
    const policy = document.getElementById('gov-policy').value.trim()
    box.disabled = true
    try {
      await gov('set_auto_vote', { enabled: box.checked, policy })
      if (box.checked) {
        unlock('delegate_on')
        govMsg(lang === 'ko' ? '위임투표 켜짐 — 대리인이 대신 투표해요' : 'Delegate voting ON', '')
      } else {
        govMsg(lang === 'ko' ? '위임투표 꺼짐' : 'Delegate voting OFF', '')
      }
    } catch (err) {
      box.checked = !box.checked
      govMsg('', String(err))
    } finally {
      box.disabled = false
    }
  })

  document.getElementById('gov-policy-save').addEventListener('click', async () => {
    const enabled = document.getElementById('gov-autovote-toggle').checked
    const policy = document.getElementById('gov-policy').value.trim()
    govMsg('', '')
    try {
      await gov('set_auto_vote', { enabled, policy })
      govMsg(lang === 'ko' ? '정책 저장됨' : 'Policy saved', '')
    } catch (err) {
      govMsg('', String(err))
    }
  })
}

// Buttons/listeners for the mining view are bound exactly once at boot —
// enterMiningView() (called on every view transition into it) only
// populates data, so re-entering never double-registers a handler.
function initMiningView() {
  document.getElementById('withdraw-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const errEl = document.getElementById('withdraw-error')
    const okEl = document.getElementById('withdraw-result')
    errEl.hidden = true
    okEl.hidden = true
    const btn = document.getElementById('withdraw-submit')
    btn.disabled = true
    btn.textContent = 'Withdrawing…'
    try {
      const to = document.getElementById('withdraw-to').value.trim()
      const password = document.getElementById('withdraw-password').value
      const r = await invoke('withdraw_earnings', { to, password })
      document.getElementById('withdraw-password').value = ''
      if (r.total_sent > 0) {
        const notes = r.results.filter((x) => x.error).map((x) => x.error)
        okEl.textContent = `Sent $${r.total_sent.toFixed(2)} to ${to.slice(0, 6)}…${to.slice(-4)}` + (notes.length ? ` (${notes.join('; ')})` : '')
        okEl.hidden = false
        appendLog(`Withdrew $${r.total_sent.toFixed(2)} to ${to.slice(0, 6)}…${to.slice(-4)}`)
        refreshWallet()
      } else {
        const notes = r.results.map((x) => x.error).filter(Boolean)
        errEl.textContent = notes.length ? notes.join('; ') : 'Nothing to withdraw yet.'
        errEl.hidden = false
      }
    } catch (err) {
      errEl.textContent = String(err)
      errEl.hidden = false
    } finally {
      btn.disabled = false
      btn.textContent = 'Withdraw'
    }
  })
  document.getElementById('start-btn').addEventListener('click', async () => {
    appendLog('Starting…')
    try {
      await invoke('start_mining')
    } catch (err) {
      appendLog(`Could not start: ${err}`)
    }
  })

  document.getElementById('stop-btn').addEventListener('click', async () => {
    await invoke('stop_mining')
  })

  document.getElementById('forget-btn').addEventListener('click', async () => {
    await invoke('forget_account')
    location.reload()
  })

  // Image-mining toggle: declares/undeclares the 'image' capability on
  // the platform so the matcher (auto-mine) routes image jobs here.
  // The image checkbox is a mirror of the image lane — route it through the
  // unified lanes model so it never fights the game shop's lane controls.
  document.getElementById('image-mining-toggle').addEventListener('change', async (e) => {
    const box = e.target
    const errEl = document.getElementById('image-mining-error')
    errEl.hidden = true
    box.disabled = true
    game.lanes.image = box.checked
    try {
      await invoke('set_lanes', { image: game.lanes.image, audio: game.lanes.audio })
      appendLog(box.checked ? 'Image lane ON — this agent now claims image jobs too.' : 'Image lane OFF.')
      saveGame()
      renderGame()
    } catch (err) {
      game.lanes.image = !game.lanes.image
      box.checked = game.lanes.image
      errEl.textContent = String(err)
      errEl.hidden = false
    } finally {
      box.disabled = false
      updateLaneModelRows()
    }
  })

  // Audio-mining toggle: declares/undeclares the 'audio' capability. Same
  // unified-lanes model as image — the checkbox is the source of truth, and
  // enabling it also marks the lane "unlocked" so the game shop reflects it.
  document.getElementById('audio-mining-toggle').addEventListener('change', async (e) => {
    const box = e.target
    const errEl = document.getElementById('image-mining-error')
    errEl.hidden = true
    box.disabled = true
    game.lanes.audio = box.checked
    if (box.checked) game.lanes.audioUnlocked = true
    try {
      await invoke('set_lanes', { image: game.lanes.image, audio: game.lanes.audio })
      appendLog(box.checked ? 'Audio lane ON — this agent now claims audio jobs too.' : 'Audio lane OFF.')
      saveGame()
      renderGame()
    } catch (err) {
      game.lanes.audio = !game.lanes.audio
      box.checked = game.lanes.audio
      errEl.textContent = String(err)
      errEl.hidden = false
    } finally {
      box.disabled = false
      updateLaneModelRows()
    }
  })

  document.getElementById('image-model-select').addEventListener('change', saveLaneModels)
  document.getElementById('audio-voice-select').addEventListener('change', saveLaneModels)

  // Parallel jobs — how many tasks the miner runs at once (single poll driver,
  // N executor slots on the Rust side). Reflect the stored value, then persist
  // changes; takes effect on the next poll, no restart needed.
  const concSel = document.getElementById('concurrency-select')
  if (concSel) {
    invoke('get_concurrency').then((n) => { concSel.value = String(n) }).catch(() => {})
    concSel.addEventListener('change', () => {
      invoke('set_concurrency', { slots: Number(concSel.value) })
        .then((applied) => { concSel.value = String(applied) })
        .catch((e) => appendLog(`Setting parallel jobs failed: ${e}`))
    })
  }

  document.getElementById('connect-open-btn').addEventListener('click', async () => {
    try {
      await invoke('open_url', { url: 'https://ai-agent-credit-dashboard.vercel.app/connect' })
    } catch (err) {
      appendLog(`Could not open browser: ${err}`)
    }
  })

  listen('mining-event', (event) => onMiningEvent(event.payload))
}

async function enterMiningView() {
  refreshRepoLane().catch(() => {})
  refreshHarnessLane().catch(() => {})
  const cfg = await invoke('load_config')
  if (!cfg.agent) return showView('register')
  if (!cfg.backend) return enterBackendView()

  showView('mining')
  platformBase = (cfg.agent.platform_url || '').replace(/\/$/, '')
  setText('agent-name-display', cfg.agent.name)
  setText('backend-label-display', backendLabel(cfg.backend))
  document.getElementById('image-mining-toggle').checked = Boolean(game.lanes.image || cfg.image_mining)
  game.lanes.image = document.getElementById('image-mining-toggle').checked
  document.getElementById('audio-mining-toggle').checked = Boolean(game.lanes.audio)
  // Restore the saved lane model / voice, then show the pickers for on lanes.
  document.getElementById('image-model-select').dataset.saved = cfg.image_model || ''
  document.getElementById('audio-voice-select').value = cfg.audio_voice || 'en'
  updateLaneModelRows()

  renderGame()
  startIdleWorld() // canvas scene + passive drone production + offline catch-up
  refreshWallet()
  if (!walletTimer) walletTimer = setInterval(refreshWallet, 60_000)
}

// ---------- Boot ----------

// ── Repo-job lane ───────────────────────────────────────────────────────
//
// The lane's whole job in the UI is to be honest about two things: whether
// this machine can actually do repo work (Node, credentials, an approved
// folder), and what the last run really produced. A claimed job that quietly
// did nothing is worse than a lane that says it is not ready.

function repoSay(kind, text) {
  const err = document.getElementById('repo-error')
  const ok = document.getElementById('repo-result')
  err.hidden = kind !== 'error'
  ok.hidden = kind !== 'ok'
  if (kind === 'error') err.textContent = text
  if (kind === 'ok') ok.textContent = text
}

async function refreshRepoLane() {
  try {
    const st = await invoke('repo_lane_status')
    document.getElementById('repo-readiness').textContent = st.detail
    const line = document.getElementById('repo-workspace-line')
    line.hidden = !st.workspace
    if (st.workspace) line.textContent = `Workspace: ${st.workspace}`
    document.getElementById('repo-run-btn').disabled = !st.ready
    document.getElementById('repo-dry-btn').disabled = !st.node
  } catch (e) {
    document.getElementById('repo-readiness').textContent = String(e)
  }
}

function describeRepoRun(r) {
  if (r.status === 'no-jobs') return r.note || 'No open repo jobs on the board right now.'
  if (r.status === 'dry-run') {
    return r.job_id
      ? `Would claim job #${r.job_id} — ${r.repo} ($${r.bounty_usd}). Nothing claimed or spent.`
      : 'Nothing to claim right now.'
  }
  if (r.status === 'no-changes') return r.note || 'The run changed no files, so nothing was submitted.'
  if (r.status === 'error') return r.note || r.error || 'The run failed.'
  const parts = [`Job #${r.job_id} — ${r.repo}`]
  if (typeof r.cost_usd === 'number') parts.push(`spent $${r.cost_usd.toFixed(2)} of $${r.bounty_usd}`)
  parts.push(r.verdict === 'awaiting review' ? 'submitted; the PR is open and CI decides next' : `verdict: ${r.verdict}`)
  return parts.join(' · ')
}

async function runRepoJob(dryRun) {
  const btn = document.getElementById(dryRun ? 'repo-dry-btn' : 'repo-run-btn')
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = dryRun ? 'Checking…' : 'Working… (this takes a while)'
  repoSay(null, '')
  try {
    const r = await invoke('run_repo_job', { dryRun })
    repoSay(r.status === 'error' ? 'error' : 'ok', describeRepoRun(r))
  } catch (e) {
    repoSay('error', String(e))
  } finally {
    btn.textContent = label
    btn.disabled = false
    await refreshRepoLane()
  }
}

function initRepoView() {
  document.getElementById('repo-pick-btn').addEventListener('click', async () => {
    try {
      const picked = await invoke('pick_repo_workspace')
      if (picked) repoSay('ok', `Workspace set to ${picked}. Repo jobs are cloned there and nowhere else.`)
    } catch (e) {
      repoSay('error', String(e))
    }
    await refreshRepoLane()
  })
  document.getElementById('repo-dry-btn').addEventListener('click', () => runRepoJob(true))
  document.getElementById('repo-run-btn').addEventListener('click', () => runRepoJob(false))
}


// ── Harness lane ────────────────────────────────────────────────────────

function harnessSay(kind, text) {
  const err = document.getElementById('harness-error')
  const ok = document.getElementById('harness-ok')
  err.hidden = kind !== 'error'
  ok.hidden = kind !== 'ok'
  if (kind === 'error') err.textContent = text
  if (kind === 'ok') ok.textContent = text
}

async function refreshHarnessLane() {
  try {
    const st = await invoke('harness_status')
    document.getElementById('harness-readiness').textContent = st.detail
    const line = document.getElementById('harness-workdir-line')
    line.hidden = !st.workdir
    if (st.workdir) line.textContent = `Scratch folder: ${st.workdir}`
    const row = document.getElementById('harness-bin-row')
    const sel = document.getElementById('harness-bin-select')
    row.hidden = st.installed.length === 0
    sel.innerHTML = ''
    for (const bin of st.installed) {
      const opt = document.createElement('option')
      opt.value = bin
      opt.textContent = bin
      if (bin === st.chosen) opt.selected = true
      sel.appendChild(opt)
    }
    const toggle = document.getElementById('harness-toggle')
    toggle.checked = st.enabled
    // Turning OFF must always be possible, even when no longer "ready".
    toggle.disabled = !st.ready && !st.enabled
  } catch (e) {
    document.getElementById('harness-readiness').textContent = String(e)
  }
}

function initHarnessView() {
  document.getElementById('harness-pick-btn').addEventListener('click', async () => {
    try {
      const picked = await invoke('pick_harness_workdir')
      if (picked) harnessSay('ok', `Scratch folder set to ${picked}. The harness works there and nowhere else you chose.`)
    } catch (e) {
      harnessSay('error', String(e))
    }
    await refreshHarnessLane()
  })
  const apply = async (enabled) => {
    const bin = document.getElementById('harness-bin-select').value || null
    try {
      harnessSay(null, '')
      await invoke('set_harness', { enabled, bin })
    } catch (e) {
      harnessSay('error', String(e))
    }
    await refreshHarnessLane()
  }
  document.getElementById('harness-toggle').addEventListener('change', (e) => apply(e.target.checked))
  document.getElementById('harness-bin-select').addEventListener('change', () => {
    if (document.getElementById('harness-toggle').checked) apply(true)
  })
}

// ── Deep link (handsel://connect) ───────────────────────────────────────

function showDeepLinkBanner(info) {
  const banner = document.getElementById('deeplink-banner')
  document.getElementById('deeplink-text').textContent =
    `A dashboard link wants to connect agent ${info.agent_id} on ${info.platform_url} to this Miner. ` +
    'Only confirm if YOU clicked that link just now — this machine would mine into that agent\'s wallet.'
  banner.hidden = false
}

function initDeepLink() {
  listen('deep-link-connect', (event) => showDeepLinkBanner(event.payload))
  // A cold-start deep link can arrive before this listener exists — the
  // pending connect survives in Rust, so ask once at boot.
  invoke('pending_connect_info')
    .then((info) => { if (info) showDeepLinkBanner(info) })
    .catch(() => {})
  document.getElementById('deeplink-confirm').addEventListener('click', async () => {
    try {
      await invoke('confirm_pending_connect')
      window.location.reload() // re-enter the boot flow with the new agent
    } catch (e) {
      document.getElementById('deeplink-text').textContent = String(e)
    }
  })
  document.getElementById('deeplink-reject').addEventListener('click', async () => {
    await invoke('reject_pending_connect').catch(() => {})
    document.getElementById('deeplink-banner').hidden = true
  })
}

async function boot() {
  applyLang()
  document.getElementById('lang-toggle').addEventListener('click', () => {
    lang = lang === 'ko' ? 'en' : 'ko'
    localStorage.setItem('miner-lang', lang)
    applyLang()
    renderGame() // badge tooltips follow the language
  })

  await initRegisterView()
  initBackendView()
  initMiningView()
  initDelegateView()
  initGovernanceView()
  initRepoView()
  initHarnessView()
  initDeepLink()

  document.getElementById('pet-wrap').addEventListener('click', onPetClick)
  document.getElementById('shop-toggle').addEventListener('click', () => {
    const shop = document.getElementById('shop')
    shop.hidden = !shop.hidden
    renderShop()
  })

  const cfg = await invoke('load_config')
  if (!cfg.agent) {
    showView('register')
  } else if (!cfg.backend) {
    await enterBackendView()
  } else {
    await enterMiningView()
  }
}

boot()
