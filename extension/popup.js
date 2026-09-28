/* global chrome */

const PROD = 'https://handsel-main.vercel.app'
const SCOPE = 'extension:read extension:write'
const $ = (id) => document.getElementById(id)
const state = { baseUrl: PROD, token: null, clientId: null, dashboard: null }

function base64url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return base64url(bytes)
}

async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

function setStatus(message, isError = false) {
  $('status').textContent = message
  $('status').classList.toggle('error', isError)
}

function safeBase(value) {
  const option = [...$('deployment').options].find((entry) => entry.value === value)
  return option ? option.value : PROD
}

async function authorize() {
  const redirectUri = chrome.identity.getRedirectURL('oauth2')
  const storageKey = `oauth:${state.baseUrl}`
  const saved = (await chrome.storage.local.get(storageKey))[storageKey]
  let clientId = saved?.clientId

  if (!clientId) {
    const registration = await fetch(`${state.baseUrl}/api/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Handsel Spend Controls for Chrome',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    const registered = await registration.json()
    if (!registration.ok || !registered.client_id) throw new Error(registered.error_description || registered.error || 'Could not register the extension with Handsel.')
    clientId = registered.client_id
    await chrome.storage.local.set({ [storageKey]: { clientId } })
  }

  const verifier = randomString(48)
  const challenge = await sha256(verifier)
  const oauthState = randomString(24)
  const authorizeUrl = new URL(`${state.baseUrl}/oauth/authorize`)
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: oauthState,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  const callback = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl.toString(), interactive: true })
  if (!callback) throw new Error('Sign-in was cancelled.')
  const result = new URL(callback)
  if (result.searchParams.get('state') !== oauthState) throw new Error('Sign-in state did not match. Please retry.')
  const error = result.searchParams.get('error')
  if (error) throw new Error(error === 'access_denied' ? 'Access was denied.' : `Sign-in failed: ${error}`)
  const code = result.searchParams.get('code')
  if (!code) throw new Error('Handsel did not return an authorization code.')

  const tokenResponse = await fetch(`${state.baseUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })
  const tokenBody = await tokenResponse.json()
  if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(tokenBody.error_description || 'Could not finish sign-in.')
  const stored = { baseUrl: state.baseUrl, token: tokenBody.access_token, expiresAt: Date.now() + tokenBody.expires_in * 1000 }
  await chrome.storage.local.set({ connected: stored })
  state.token = stored.token
}

async function api(path, options = {}) {
  const response = await fetch(`${state.baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${state.token}`, ...(options.headers || {}) },
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401) throw new Error('Your connection expired. Connect Handsel again.')
    throw new Error(payload.error || `Handsel request failed (${response.status}).`)
  }
  return payload
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`
}

function renderAgent(agent) {
  const card = document.createElement('article')
  card.className = 'agent-card'
  card.dataset.agentId = agent.agentId
  card.innerHTML = `
    <div class="agent-title"><strong title="${escapeHtml(agent.name)}">${escapeHtml(agent.name)}</strong><span class="spent">${money(agent.spentTodayUsd)} spent / 24h</span></div>
    <div class="limit-grid">
      <div><label>PER PAYMENT · $</label><input data-field="perTxMaxUsd" type="number" min="0" step="0.01" value="${Number(agent.envelope.perTxMaxUsd)}"></div>
      <div><label>PER 24H · $</label><input data-field="dailyMaxUsd" type="number" min="0" step="0.01" value="${Number(agent.envelope.dailyMaxUsd)}"></div>
      <div><label>AUTO-APPROVE · $</label><input data-field="autoApproveMaxUsd" type="number" min="0" step="0.01" value="${Number(agent.envelope.autoApproveMaxUsd)}"></div>
    </div>
    <div class="save-row"><span class="save-result"></span><button class="save-button" type="button">Save limits</button></div>`
  card.querySelector('.save-button').addEventListener('click', () => saveLimits(card))
  return card
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function renderRecent(item, names) {
  const row = document.createElement('div')
  row.className = 'spend-row'
  const date = new Date(item.createdAt)
  const verdict = String(item.verdict || '').toLowerCase()
  row.innerHTML = `<span class="spend-agent">${escapeHtml(names.get(item.agentId) || 'Agent')} · ${escapeHtml(item.kind.replaceAll('_', ' '))}</span>
    <span class="spend-amount">${money(item.amountUsd)}</span>
    <span class="spend-meta">${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    <span class="verdict ${verdict}">${escapeHtml(item.verdict)}</span>`
  return row
}

async function loadDashboard() {
  setStatus('Loading your spending controls…')
  const dashboard = await api('/api/extension/dashboard')
  state.dashboard = dashboard
  $('email').textContent = dashboard.user.email
  $('agent-count').textContent = String(dashboard.agents.length)
  const agentList = $('agents')
  agentList.replaceChildren()
  for (const item of dashboard.agents) agentList.append(renderAgent(item))
  if (!dashboard.agents.length) agentList.innerHTML = '<div class="empty">No agents on this Handsel account yet.</div>'
  const names = new Map(dashboard.agents.map((agent) => [agent.agentId, agent.name]))
  const recentList = $('recent')
  recentList.replaceChildren()
  for (const item of dashboard.recent) recentList.append(renderRecent(item, names))
  if (!dashboard.recent.length) recentList.innerHTML = '<div class="empty">No spending records yet.</div>'
  const dashboardUrl = state.baseUrl === 'http://localhost:3000' ? state.baseUrl : state.baseUrl
  $('open-dashboard').href = `${dashboardUrl}/autonomy`
  $('connection').hidden = true
  $('dashboard').hidden = false
  setStatus('')
}

async function saveLimits(card) {
  const button = card.querySelector('.save-button')
  const result = card.querySelector('.save-result')
  const fields = Object.fromEntries([...card.querySelectorAll('input')].map((input) => [input.dataset.field, Number(input.value)]))
  button.disabled = true
  result.textContent = 'Saving…'
  try {
    await api('/api/extension/dashboard', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: card.dataset.agentId, ...fields }),
    })
    result.textContent = 'Saved'
    await loadDashboard()
  } catch (error) {
    result.textContent = error.message
    result.style.color = '#ffad93'
  } finally {
    button.disabled = false
  }
}

async function connect() {
  const button = $('connect')
  button.disabled = true
  state.baseUrl = safeBase($('deployment').value)
  setStatus('Opening secure Handsel sign-in…')
  try {
    await authorize()
    await loadDashboard()
  } catch (error) {
    setStatus(error.message, true)
  } finally {
    button.disabled = false
  }
}

async function disconnect() {
  const stored = (await chrome.storage.local.get('connected')).connected
  if (stored?.token && stored?.baseUrl) {
    try {
      await fetch(`${safeBase(stored.baseUrl)}/api/extension/dashboard`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${stored.token}` },
      })
    } catch {
      // Removing the local credential still disconnects this browser if the service is unavailable.
    }
    await chrome.storage.local.remove(`oauth:${stored.baseUrl}`)
  }
  await chrome.storage.local.remove('connected')
  state.token = null
  $('dashboard').hidden = true
  $('connection').hidden = false
  setStatus('Disconnected.')
}

async function init() {
  const stored = (await chrome.storage.local.get('connected')).connected
  state.baseUrl = safeBase(stored?.baseUrl)
  $('deployment').value = state.baseUrl
  $('connect').addEventListener('click', connect)
  $('disconnect').addEventListener('click', disconnect)
  $('refresh').addEventListener('click', async () => {
    if (!state.token) return
    try { await loadDashboard() } catch (error) { setStatus(error.message, true) }
  })
  $('deployment').addEventListener('change', async () => {
    state.baseUrl = safeBase($('deployment').value)
    if (stored?.baseUrl !== state.baseUrl) {
      state.token = null
      $('dashboard').hidden = true
      $('connection').hidden = false
    }
  })
  if (stored?.token && stored.expiresAt > Date.now()) {
    state.baseUrl = safeBase(stored.baseUrl)
    state.token = stored.token
    $('deployment').value = state.baseUrl
    try {
      await loadDashboard()
    } catch (error) {
      setStatus(error.message, true)
      $('connection').hidden = false
      $('dashboard').hidden = true
    }
  } else {
    $('connection').hidden = false
    $('dashboard').hidden = true
    if (stored?.token) setStatus('Your connection expired. Connect Handsel again.')
  }
}

document.addEventListener('DOMContentLoaded', init)
