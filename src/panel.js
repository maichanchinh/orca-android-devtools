const orca = window.orca
const rootEl = document.querySelector('#app')
const preferencesKey = 'android-devtools.project-preferences.v1'
const preferenceFields = ['profile', 'profileName', 'module', 'variant', 'device', 'install', 'clearData', 'activity', 'uri', 'launchFlags', 'extras', 'extraKey', 'extraValue', 'extraType']

const state = {
  workspaces: [], workspaceId: '', root: '', workspaceName: '', branch: '', project: null, projectLoading: false,
  devices: [], devicesLoading: false, config: { version: 1 }, screen: 'run',
  module: '', variant: '', device: '', profile: '', profileName: '', install: true, clearData: false,
  activity: '', uri: '', launchFlags: '', extraKey: '', extraValue: '', extraType: 'boolean', extras: [],
  running: false, runId: '', status: 'Ready', result: null, showLogs: false, buildLogs: [], runLogs: [],
  agentCount: 0, toast: '', yaml: '', yamlLoading: false
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const onlineDevices = () => state.devices.filter((device) => device.state === 'device')
const projectReady = () => Boolean(state.project?.supported)
const getReason = () => {
  if (state.projectLoading) return 'Detecting Android project…'
  if (!projectReady()) return state.project?.reason || (state.root ? 'No Android application module detected.' : 'Open an Android project workspace to enable Run.')
  if (!onlineDevices().length) return state.devices.some((device) => device.state === 'unauthorized') ? 'Authorize USB debugging on the device.' : state.devices.some((device) => device.state === 'offline') ? 'Reconnect the offline device.' : 'Connect a device or start an emulator.'
  if (!onlineDevices().some((device) => device.serial === state.device)) return 'Select an online device.'
  if (!state.variant) return 'Select an available build variant.'
  return ''
}
const canRun = () => !state.running && projectReady() && onlineDevices().some((device) => device.serial === state.device) && Boolean(state.variant)

async function hostCall(method, params = {}) { return orca.host.call(method, params) }
async function request(name, params = {}, options) { return orca.plugin.request(name, params, options) }

function notify(message) {
  state.toast = message
  render()
  window.setTimeout(() => { if (state.toast === message) { state.toast = ''; render() } }, 2600)
}

async function persistPreferences() {
  if (!state.root || !state.project) return
  const preferences = Object.fromEntries(preferenceFields.map((key) => [key, state[key]]))
  try {
    const saved = await hostCall('storage.get', { key: preferencesKey })
    const all = saved?.value && typeof saved.value === 'object' ? saved.value : {}
    await hostCall('storage.set', { key: preferencesKey, value: { ...all, [state.project.root]: preferences, [state.root]: preferences } })
  } catch { /* The panel still works if plugin storage is temporarily unavailable. */ }
}

async function loadPreferences(projectRoot, workspacePath) {
  try {
    const { value } = await hostCall('storage.get', { key: preferencesKey })
    return value?.[projectRoot] ?? value?.[workspacePath] ?? null
  } catch { return null }
}

async function refreshDevices(force = false) {
  state.devicesLoading = true
  render()
  try {
    const { devices } = await request('android.devices', force ? { refresh: true } : {})
    const online = devices.filter((device) => device.state === 'device')
    state.devices = devices
    if (!online.some((device) => device.serial === state.device)) state.device = online.length === 1 ? online[0].serial : ''
  } catch (error) {
    state.toast = error.message || 'Could not load Android devices.'
  } finally {
    state.devicesLoading = false
    render()
    void persistPreferences()
  }
}

async function refreshWorkspaces(force = false) {
  state.projectLoading = true
  render()
  try {
    const { workspaces, focusedId, focusedName, focusedBranch } = await request('android.workspaces')
    state.workspaces = workspaces
    const focused = workspaces.find((workspace) => workspace.id === focusedId) ?? workspaces.find((workspace) => workspace.name === focusedName)
    const currentExists = workspaces.some((workspace) => workspace.id === state.workspaceId)
    const workspaceId = focused?.id ?? (currentExists ? state.workspaceId : workspaces.length === 1 ? workspaces[0].id : '')
    const workspace = workspaces.find((item) => item.id === workspaceId)
    if (!workspace) {
      state.workspaceId = ''; state.root = ''; state.workspaceName = ''; state.branch = ''; state.project = null; state.projectLoading = false
      state.config = { version: 1 }; state.profile = ''; state.module = ''; state.variant = ''; state.device = ''
      state.status = 'No active project'
      render()
      void refreshDevices()
      return
    }
    state.workspaceId = workspace.id
    state.workspaceName = workspace.name
    state.branch = workspace.branch || (workspace.id === focused?.id ? focusedBranch : '') || ''
    state.root = workspace.path
    await discover(workspace, undefined, force)
  } catch (error) {
    state.project = null; state.projectLoading = false; state.status = error.message || 'Workspace discovery failed.'
    render()
  }
}

async function discover(workspace, requestedModule, force = false) {
  state.workspaceId = workspace.id; state.workspaceName = workspace.name; state.root = workspace.path
  state.project = null; state.projectLoading = true; state.status = force ? 'Refreshing project…' : 'Discovering project…'; state.result = null
  render()
  try {
    const remembered = await loadPreferences(workspace.path, workspace.path)
    const moduleHint = requestedModule ?? remembered?.module
    const { project, devices, config } = await request('android.discover', { root: workspace.path, ...(moduleHint ? { module: moduleHint } : {}), ...(force ? { refresh: true } : {}) }, { timeoutMs: 120000 })
    state.project = project; state.config = config; state.devices = devices
    const savedProfile = remembered?.profile && config.profiles?.[remembered.profile] ? remembered.profile : config.profile ?? ''
    const profile = savedProfile ? config.profiles?.[savedProfile] : undefined
    const online = devices.filter((device) => device.state === 'device')
    const nextModule = (requestedModule && project.modules.includes(requestedModule) ? requestedModule : undefined)
      ?? (remembered?.module && project.modules.includes(remembered.module) ? remembered.module : undefined)
      ?? profile?.module ?? project.module
    Object.assign(state, {
      profile: savedProfile, profileName: remembered?.profileName ?? savedProfile,
      module: nextModule,
      variant: remembered?.variant && project.variants.includes(remembered.variant) ? remembered.variant : profile?.variant ?? project.variants.find((variant) => variant.toLowerCase() === 'debug') ?? project.variants[0] ?? '',
      device: remembered?.device && online.some((device) => device.serial === remembered.device) ? remembered.device : profile?.device && online.some((device) => device.serial === profile.device) ? profile.device : online.length === 1 ? online[0].serial : '',
      install: remembered?.install ?? profile?.install ?? true,
      clearData: remembered?.clearData ?? profile?.clearData ?? false,
      activity: remembered?.activity ?? profile?.activity ?? '', uri: remembered?.uri ?? profile?.uri ?? '',
      launchFlags: remembered?.launchFlags ?? profile?.launchFlags ?? '', extras: remembered?.extras ?? profile?.extras ?? [],
      projectLoading: false,
      status: project.supported ? online.length ? 'Ready' : 'No online device' : project.reason ?? 'Unsupported project'
    })
    render()
    void persistPreferences()
  } catch (error) {
    state.project = null; state.projectLoading = false; state.status = error.message || 'Project discovery failed.'; render()
  }
}

function profileConfig(name = state.profile) { return name ? state.config.profiles?.[name] : undefined }
function applyProfile(name) {
  const profile = profileConfig(name)
  state.profile = name
  state.profileName = name
  state.module = profile?.module ?? state.project?.module ?? ''
  state.variant = profile?.variant ?? state.project?.variants?.find((variant) => variant.toLowerCase() === 'debug') ?? state.project?.variants?.[0] ?? ''
  state.device = profile?.device && onlineDevices().some((device) => device.serial === profile.device) ? profile.device : onlineDevices().length === 1 ? onlineDevices()[0].serial : ''
  state.install = profile?.install ?? true; state.clearData = profile?.clearData ?? false
  state.activity = profile?.activity ?? ''; state.uri = profile?.uri ?? ''; state.launchFlags = profile?.launchFlags ?? ''; state.extras = profile?.extras ?? []
  void persistPreferences(); render(); schedulePreview()
}

function parseExtra(raw, type) {
  if (type === 'string') return raw
  if (type === 'boolean') {
    if (!['true', 'false'].includes(raw.toLowerCase())) throw new Error('Boolean extra must be true or false.')
    return raw.toLowerCase() === 'true'
  }
  if (!raw.trim()) throw new Error(`${type} value is required.`)
  if (type === 'long') {
    if (!/^-?\d+$/.test(raw)) throw new Error('Long extra must be an integer.')
    const value = BigInt(raw)
    if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) throw new Error('Long extra is outside the signed 64-bit range.')
    return value.toString()
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`Invalid ${type} value.`)
  if (type === 'int' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) throw new Error('Integer extra must be a signed 32-bit value.')
  if (type === 'float' && Math.abs(value) > 3.4028235e38) throw new Error('Float extra is outside the supported range.')
  return value
}

function profileFromForm() {
  return {
    module: state.module, variant: state.variant, ...(state.device ? { device: state.device } : {}),
    build: true, install: state.install, clearData: state.clearData,
    ...(state.activity ? { activity: state.activity } : {}), ...(state.uri ? { uri: state.uri } : {}),
    ...(state.launchFlags ? { launchFlags: state.launchFlags } : {}), extras: [...state.extras]
  }
}

let previewTimer
function schedulePreview() {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(updatePreview, 220)
}
async function updatePreview() {
  if (!state.root || !state.profileName.trim()) { state.yaml = ''; renderYaml(); return }
  state.yamlLoading = true; renderYaml()
  try {
    const { yaml } = await request('android.profile.preview', { root: state.root, name: state.profileName.trim(), profile: profileFromForm() })
    state.yaml = yaml
  } catch (error) { state.yaml = error.message || 'Complete valid profile values to preview YAML.' }
  state.yamlLoading = false; renderYaml()
}

async function saveProfile() {
  if (!state.root || !state.profileName.trim()) return notify('Enter a profile name first.')
  try {
    await request('android.profile.save', { root: state.root, name: state.profileName.trim(), profile: profileFromForm() })
    state.profile = state.profileName.trim()
    notify('Profile saved to .android-devtools.yaml')
    const workspace = state.workspaces.find((item) => item.id === state.workspaceId)
    if (workspace) await discover(workspace, state.module)
    state.screen = 'profiles'; render(); schedulePreview()
  } catch (error) { notify(error.message || 'Could not save profile.') }
}

async function deleteProfile() {
  if (!state.root || !state.profile) return
  try {
    const { deleted } = await request('android.profile.delete', { root: state.root, name: state.profile })
    state.profile = ''; state.profileName = ''; state.extras = []; state.clearData = false
    notify(deleted ? 'Profile deleted.' : 'Profile was not found.')
    const workspace = state.workspaces.find((item) => item.id === state.workspaceId)
    if (workspace) await discover(workspace)
    render()
  } catch (error) { notify(error.message || 'Could not delete profile.') }
}

async function startRun() {
  if (!canRun()) return
  const extras = [...state.extras]
  if (state.extraKey.trim()) {
    try { extras.push({ key: state.extraKey.trim(), type: state.extraType, value: parseExtra(state.extraValue, state.extraType) }) }
    catch (error) { return notify(error.message) }
  }
  state.running = true; state.status = 'Starting…'; state.result = null; state.buildLogs = []; state.runLogs = []; render()
  try {
    const { runId } = await request('android.run.start', {
      root: state.root, ...(state.profile ? { profile: state.profile } : {}),
      options: { module: state.module, variant: state.variant, device: state.device, build: true, install: state.install, clearData: state.clearData,
        ...(state.activity ? { activity: state.activity } : {}), ...(state.uri ? { uri: state.uri } : {}), ...(state.launchFlags ? { launchFlags: state.launchFlags } : {}), extras }
    }, { timeoutMs: 120000 })
    state.runId = runId; state.status = 'Running…'
  } catch (error) { state.running = false; state.status = error.message || 'Run request failed.'; state.runLogs.push(`Run request failed: ${state.status}`) }
  render()
}

async function cancelRun() {
  if (!state.runId) return
  try { await request('android.run.cancel', { runId: state.runId }); state.status = 'Cancelling…' }
  catch (error) { state.status = error.message || 'Could not cancel run.' }
  render()
}

async function copyText(text, label) {
  if (!text) return notify(`No ${label} output to copy.`)
  try { await navigator.clipboard.writeText(text); notify(`${label} copied.`) }
  catch { notify('Clipboard unavailable; select the log text and copy it.') }
}

async function sendLog(kind) {
  const lines = kind === 'build' ? state.buildLogs : state.runLogs
  if (!lines.length) return notify(`No ${kind} output to send.`)
  try {
    await request('android.agent.sendLog', { text: `Android Devtools ${kind} log:\n\n${lines.join('\n')}` })
    notify(`${kind} log inserted in agent input.`)
  } catch (error) { notify(error.message || 'Could not send log to the agent.') }
}

function renderOptions() {
  return `<section class="section"><div class="label">Run options</div><div class="options-grid">
    <label class="check-option"><input type="checkbox" data-field="install" ${state.install ? 'checked' : ''} ${!projectReady() || state.running ? 'disabled' : ''}><span>Install APK</span></label>
    <label class="check-option"><input type="checkbox" data-field="clearData" ${state.clearData ? 'checked' : ''} ${!projectReady() || state.running ? 'disabled' : ''}><span>Clear App Data</span></label>
  </div></section>`
}

function renderMain() {
  const reason = getReason()
  const debug = state.project?.variants?.find((variant) => variant.toLowerCase() === 'debug')
  const release = state.project?.variants?.find((variant) => variant.toLowerCase() === 'release')
  const extras = (state.project?.variants ?? []).filter((variant) => variant !== debug && variant !== release)
  const deviceOptions = state.devices.length ? state.devices.map((device) => `<option value="${esc(device.serial)}" ${state.device === device.serial ? 'selected' : ''} ${device.state !== 'device' ? 'disabled' : ''}>${esc(device.model)} · ${esc(device.serial)}${device.state !== 'device' ? ` (${esc(device.state)})` : ''}</option>`).join('') : `<option value="">${state.devicesLoading ? 'Searching for devices…' : 'No ADB devices found'}</option>`
  const profileOptions = `<option value="">Default</option>${Object.keys(state.config.profiles ?? {}).map((name) => `<option value="${esc(name)}" ${state.profile === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}`
  const statusTone = state.result?.status === 'success' ? 'success' : state.result?.status === 'failed' ? 'error' : state.projectLoading ? 'warning' : projectReady() ? 'success' : 'warning'
  const operation = state.running ? 'Running' : state.result?.status === 'success' ? 'Success' : state.result?.status === 'failed' ? 'Failed' : state.result?.status === 'cancelled' ? 'Cancelled' : 'Ready'
  const operationText = state.running ? state.status : state.result?.error?.message ?? (state.result?.status === 'success' ? 'Run completed' : state.result?.status === 'cancelled' ? 'Operation cancelled' : reason || 'Ready to run')
  const currentModule = (state.module || state.project?.module || '').replace(/^:/, '').replace(/:/g, ' · ')
  return `<div class="header"><div class="header-title"><div class="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.2 8.2 5.6 5.6a.65.65 0 0 1 1.1-.7l1.7 2.8a10 10 0 0 1 7.2 0l1.7-2.8a.65.65 0 1 1 1.1.7l-1.6 2.6a7.8 7.8 0 0 1 3.1 6.2v.5H4.1v-.5a7.8 7.8 0 0 1 3.1-6.2ZM8.4 11a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Zm7.2 0a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z"/></svg></div><div><h1>Android Run</h1><div class="subtitle">Build · Install · Run · Manage</div></div></div>
    <div class="header-actions"><button class="icon-btn" data-action="refresh-all" aria-label="Refresh project and devices" title="Refresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2"/></svg></button><button class="icon-btn" data-action="profiles" aria-label="Open Profile Manager" title="Profile Manager"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 14 4l2.5-.3 1.2 2.2 2.2 1.2-.3 2.5 1 2.4-1 2.4.3 2.5-2.2 1.2-1.2 2.2-2.5-.3-2.4 1-2.4-1-2.5.3-1.2-2.2-2.2-1.2.3-2.5-1-2.4 1-2.4-.3-2.5 2.2-1.2 1.2-2.2 2.5.3z"/><circle cx="12" cy="12" r="3"/></svg></button></div></div>
    <div class="project-card"><div class="project-row"><div class="project-mark">●</div><div class="project-copy"><div class="project-name">${esc(state.project?.rootProjectName || (state.project?.supported ? state.workspaceName || state.project.applicationId || 'Android project' : state.projectLoading ? 'Detecting project…' : state.root ? 'Android project not found' : 'No active project'))}</div><div class="project-path">${esc(state.project?.supported ? `${currentModule || 'app'} · ${state.project.applicationId ?? state.root}` : state.project?.reason ?? state.root ?? 'Open an Android project workspace')}</div>${state.project && state.branch ? `<div class="project-branch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10a2 2 0 0 0 2 2h8M8 7h8a2 2 0 0 1 2 2v8"/></svg>${esc(state.branch)}</div>` : ''}</div><span class="badge ${statusTone}"><span class="dot"></span>${state.project?.supported ? 'Gradle' : state.projectLoading ? 'Scanning' : 'Not recognized'}</span></div></div>
    ${state.project?.supported && state.project.modules.length > 1 ? `<div class="section"><label class="label" for="module">App module</label><select class="select" id="module" data-field="module">${state.project.modules.map((module) => `<option value="${esc(module)}" ${state.module === module ? 'selected' : ''}>${esc(module.replace(/^:/, '').replace(/:/g, ' · '))}</option>`).join('')}</select></div>` : ''}
    <div class="stack">
      <section class="section"><div class="section-head"><span class="label">Profile</span><div class="inline"><button class="quiet-btn" data-action="profiles">Edit</button><button class="quiet-btn" data-action="new-profile">＋</button></div></div><select class="select" data-field="profile" aria-label="Profile" ${!projectReady() ? 'disabled' : ''}>${profileOptions}</select></section>
      <section class="section"><div class="label">Variant</div><div class="segmented"><button class="seg-btn ${state.variant === debug ? 'active' : ''}" data-action="variant" data-value="${esc(debug ?? '')}" ${!debug || !projectReady() || state.running ? 'disabled' : ''}><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 7V4m8 3V4M7 10h10M6 7h12l1 3-2 2 1 3-2 2H8l-2-2 1-3-2-2 1-3Z"/><path d="M9 13h.01M15 13h.01M9 17l-1 3m7-3 1 3"/></svg>Debug</button><button class="seg-btn ${state.variant === release ? 'active' : ''}" data-action="variant" data-value="${esc(release ?? '')}" ${!release || !projectReady() || state.running ? 'disabled' : ''}><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 19c4-1 8-4 11-7s4-7 4-7-4 0-7 4-6 7-7 11Z"/><path d="M8 16l-3 1-2 4 5-1m5-8 4 4m-3-9 1-3m2 3 3-1"/><circle cx="15.5" cy="8.5" r="1"/></svg>Release</button></div>${extras.length ? `<select class="select" data-field="variant" aria-label="Other variant"><option value="">Other variant…</option>${extras.map((variant) => `<option value="${esc(variant)}" ${state.variant === variant ? 'selected' : ''}>${esc(variant)}</option>`).join('')}</select>` : ''}</section>
      <section class="section"><label class="label" for="device">Device</label><div class="select-wrap"><select class="select" id="device" data-field="device" ${!onlineDevices().length || state.running ? 'disabled' : ''}><option value="">${state.devicesLoading ? 'Searching for devices…' : onlineDevices().length ? 'Select device' : 'No online device'}</option>${deviceOptions}</select><button class="icon-btn" data-action="refresh-devices" aria-label="Refresh devices" title="Refresh devices" ${state.devicesLoading || state.running ? 'disabled' : ''}>↻</button></div>${state.devices.some((device) => device.state !== 'device') ? `<div class="hint">${state.devices.filter((device) => device.state !== 'device').map((device) => `${esc(device.model)}: ${device.state === 'unauthorized' ? 'authorize USB debugging' : 'reconnect device'}`).join(' · ')}</div>` : ''}</section>
      ${renderOptions()}
      <button class="primary-btn" data-action="${state.running ? 'cancel-run' : 'run'}" ${!canRun() && !state.running ? `disabled title="${esc(reason)}"` : ''}>${state.running ? '■ Cancel Run' : '▷ Run'}</button>
      <div class="status-row"><div class="inline"><span class="badge ${state.result?.status === 'failed' ? 'error' : state.result?.status === 'success' ? 'success' : ''}"><span class="dot"></span>${operation}</span><span class="status-text">${esc(operationText)}</span></div><div class="inline status-actions"><button class="quiet-btn" data-action="toggle-logs">${state.showLogs ? 'Hide logs' : 'Show logs'}</button><button class="quiet-btn" data-action="clear-logs" ${(state.buildLogs.length || state.runLogs.length) ? '' : 'disabled'}>Clear logs</button></div></div>
      ${state.result ? `<div class="hint">${state.result.durationMs} ms · exit ${state.result.exitCode ?? '—'}</div>` : ''}
      ${state.result?.status === 'failed' ? `<div class="error-callout">${esc(state.result.error?.message ?? 'Run failed')}<div style="margin-top:7px"><button class="outline-btn" data-action="copy-error">Copy error</button></div></div>` : ''}
      ${state.showLogs ? renderLogs() : ''}<div class="toast" role="status">${esc(state.toast)}</div>
    </div>`
}

function renderLogs() {
  const section = (kind, lines) => `<article class="log-card"><div class="log-head"><strong>${kind === 'build' ? 'Build output' : 'Run output'}</strong><div class="inline"><button class="quiet-btn" data-action="copy-${kind}" ${lines.length ? '' : 'disabled'}>Copy</button><button class="quiet-btn" data-action="send-${kind}" ${lines.length && state.agentCount === 1 ? '' : 'disabled'}>Send to agent</button></div></div><pre>${esc(lines.join('\n') || `No ${kind} output yet.`)}</pre></article>`
  return `<div class="logs">${section('build', state.buildLogs)}${section('run', state.runLogs)}<div class="hint">${state.agentCount === 1 ? 'Log text is inserted in the sole agent input; press Enter there to submit.' : 'Send to agent requires exactly one agent terminal in the focused workspace.'}</div></div>`
}

function renderProfiles() {
  const names = Object.keys(state.config.profiles ?? {})
  const profile = profileConfig()
  const moduleOptions = state.project?.modules ?? []
  const variantOptions = state.project?.variants ?? []
  const online = onlineDevices()
  const extras = state.extras.map((extra, index) => `<div class="extra-row"><input class="control extra-key" aria-label="Extra key" data-extra-key="${index}" value="${esc(extra.key)}"><select class="select extra-type" aria-label="Extra type" data-extra-type="${index}">${['string', 'boolean', 'int', 'long', 'float', 'double'].map((type) => `<option ${extra.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select><input class="control extra-value" aria-label="Extra value" data-extra-value="${index}" value="${esc(extra.value)}"><button class="icon-btn" data-action="remove-extra" data-index="${index}" aria-label="Remove extra">×</button></div>`).join('')
  return `<div class="profile-screen">
    <div class="page-heading"><span class="page-mark">▱</span><div style="flex:1"><h1>Profile Manager</h1><div class="subtitle">Manage run profiles in .android-devtools.yaml</div></div><button class="icon-btn" data-action="back" aria-label="Back to Android Run">×</button></div>
    <section class="section"><div class="section-head"><div class="label">Profiles (${names.length})</div><button class="outline-btn" data-action="new-profile" ${!state.root ? 'disabled' : ''}>＋ New</button></div><div class="profiles">${names.length ? names.map((name) => `<button class="profile-choice ${state.profile === name ? 'active' : ''}" data-action="select-profile" data-value="${esc(name)}">▱ &nbsp;${esc(name)}${state.profile === name ? ' <small>Active</small>' : ''}</button>`).join('') : '<div class="hint">No saved profiles yet. Create one below.</div>'}</div></section>
    ${!state.root ? '<div class="error-callout">Open an Android project workspace to create or edit project profiles.</div>' : ''}
    <div class="card"><div class="card-head">▱ &nbsp;General</div>
      <div class="field"><label for="profile-name">Profile name</label><input class="control" id="profile-name" data-field="profileName" value="${esc(state.profileName)}" placeholder="e.g. premium-ads" ${!state.root ? 'disabled' : ''}></div>
      <div class="fields-two"><div class="field"><label for="profile-module">Module</label><select class="select" id="profile-module" data-field="module" ${!state.root ? 'disabled' : ''}>${moduleOptions.map((module) => `<option value="${esc(module)}" ${module === state.module ? 'selected' : ''}>${esc(module)}</option>`).join('') || '<option value="">Default</option>'}</select></div><div class="field"><label for="profile-variant">Variant</label><select class="select" id="profile-variant" data-field="variant" ${!state.root ? 'disabled' : ''}>${variantOptions.map((variant) => `<option value="${esc(variant)}" ${variant === state.variant ? 'selected' : ''}>${esc(variant)}</option>`).join('') || '<option value="">Default</option>'}</select></div></div>
      <div class="field"><label for="profile-device">Device (optional)</label><select class="select" id="profile-device" data-field="device" ${!state.root ? 'disabled' : ''}><option value="">Use selected device</option>${online.map((device) => `<option value="${esc(device.serial)}" ${device.serial === state.device ? 'selected' : ''}>${esc(device.serial)} (${esc(device.model)})</option>`).join('')}</select></div>
      <label class="check-option"><input type="checkbox" data-field="clearData" ${state.clearData ? 'checked' : ''} ${!state.root ? 'disabled' : ''}><span>Clear app data before run</span></label>
    </div>
    <div class="card"><div class="card-head">▱ &nbsp;Launch Settings</div>
      <div class="field"><label for="activity">Activity (optional)</label><input class="control" id="activity" data-field="activity" value="${esc(state.activity)}" placeholder="com.example.MainActivity" ${!state.root ? 'disabled' : ''}></div>
      <div class="field"><label for="uri">Intent data URI (optional)</label><input class="control" id="uri" data-field="uri" value="${esc(state.uri)}" placeholder="myapp://premium" ${!state.root ? 'disabled' : ''}></div>
      <div class="field"><label for="launch-flags">Launch flags (hex)</label><input class="control" id="launch-flags" data-field="launchFlags" value="${esc(state.launchFlags)}" placeholder="0x10000000" ${!state.root ? 'disabled' : ''}></div>
    </div>
    <div class="card"><div class="card-head">▱ &nbsp;Intent Extras (${state.extras.length})</div><div class="hint">Typed Android intent extras passed when the app launches.</div><div class="extra-list">${extras || '<div class="hint">No extras in this profile.</div>'}</div>
      <div class="fields-two"><div class="field"><label for="extra-type">Type</label><select class="select" id="extra-type" data-field="extraType">${['string', 'boolean', 'int', 'long', 'float', 'double'].map((type) => `<option ${state.extraType === type ? 'selected' : ''}>${type}</option>`).join('')}</select></div><div class="field"><label for="extra-key">Key</label><input class="control" id="extra-key" data-field="extraKey" value="${esc(state.extraKey)}" placeholder="debug_premium_ads"></div></div>
      <div class="field"><label for="extra-value">Value</label><input class="control" id="extra-value" data-field="extraValue" value="${esc(state.extraValue)}" placeholder="true"></div><button class="outline-btn" data-action="add-extra">＋ Add Extra</button>
    </div>
    <div class="button-row"><button class="danger-btn" data-action="delete-profile" ${!state.profile || !state.root ? 'disabled' : ''}>Delete profile</button><div class="inline"><button class="outline-btn" data-action="back">Cancel</button><button class="primary-btn" style="width:auto;padding:0 16px;min-height:36px" data-action="save-profile" ${!state.root || !state.profileName.trim() ? 'disabled' : ''}>▣ Save changes</button></div></div>
    <details class="yaml" data-action="yaml-open"><summary>.android-devtools.yaml preview</summary><pre id="yaml-preview">${esc(state.yamlLoading ? 'Preparing preview…' : state.yaml || 'Open this section to preview the profile YAML.')}</pre></details>
    <div class="toast" role="status">${esc(state.toast)}</div>
  </div>`
}

function renderYaml() {
  const node = document.querySelector('#yaml-preview')
  if (node) node.textContent = state.yamlLoading ? 'Preparing preview…' : state.yaml || 'Open this section to preview the profile YAML.'
}
function render() { rootEl.innerHTML = state.screen === 'profiles' ? renderProfiles() : renderMain() }

async function refreshAgentCount() {
  try { const { count } = await request('android.agent.status'); state.agentCount = count }
  catch { state.agentCount = 0 }
  render()
}

function handleRunProgress({ runId, stage, message }) {
  if (runId !== state.runId) return
  const line = `${stage}: ${message}`
  state.status = message
  const target = stage === 'build' ? state.buildLogs : state.runLogs
  target.push(line); if (target.length > 200) target.splice(0, target.length - 200)
  render()
}
function handleRunChanged({ runId, status, result }) {
  if (runId !== state.runId) return
  state.running = status === 'running'
  state.result = result ?? state.result
  state.status = result?.error?.message ?? (status === 'success' ? 'Run completed' : status === 'failed' ? 'Run failed' : status === 'cancelled' ? 'Operation cancelled' : 'Running…')
  if (result?.buildLogs) state.buildLogs = result.buildLogs
  if (result?.runLogs) state.runLogs = result.runLogs
  render()
}

rootEl.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]')
  if (!button || button.disabled) return
  const action = button.dataset.action
  if (action === 'refresh-all') return void refreshWorkspaces(true)
  if (action === 'refresh-devices') return void refreshDevices(true)
  if (action === 'profiles') { state.screen = 'profiles'; render(); schedulePreview(); return }
  if (action === 'back') { state.screen = 'run'; render(); return }
  if (action === 'new-profile') {
    state.screen = 'profiles'; state.profile = ''; state.profileName = ''; state.extras = []; state.extraKey = ''; state.extraValue = ''; state.extraType = 'boolean'
    state.activity = ''; state.uri = ''; state.launchFlags = ''; state.clearData = false
    state.module = state.project?.module ?? ''; state.variant = state.project?.variants?.find((variant) => variant.toLowerCase() === 'debug') ?? state.project?.variants?.[0] ?? ''
    state.device = onlineDevices().length === 1 ? onlineDevices()[0].serial : ''
    render(); schedulePreview(); return
  }
  if (action === 'variant') { if (button.dataset.value) { state.variant = button.dataset.value; void persistPreferences(); render() } return }
  if (action === 'run') return void startRun()
  if (action === 'cancel-run') return void cancelRun()
  if (action === 'toggle-logs') { state.showLogs = !state.showLogs; render(); return }
  if (action === 'clear-logs') { state.buildLogs = []; state.runLogs = []; state.result = null; render(); return }
  if (action === 'copy-error') return void copyText([state.result?.error?.message, ...state.buildLogs, ...state.runLogs].filter(Boolean).join('\n'), 'error')
  if (action === 'copy-build') return void copyText(state.buildLogs.join('\n'), 'build log')
  if (action === 'copy-run') return void copyText(state.runLogs.join('\n'), 'run log')
  if (action === 'send-build') return void sendLog('build')
  if (action === 'send-run') return void sendLog('run')
  if (action === 'save-profile') return void saveProfile()
  if (action === 'delete-profile') return void deleteProfile()
  if (action === 'select-profile') { applyProfile(button.dataset.value); return }
  if (action === 'add-extra') {
    try {
      const key = state.extraKey.trim()
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,254}$/.test(key)) throw new Error('Extra key must start with a letter or underscore and use only supported characters.')
      state.extras.push({ key, type: state.extraType, value: parseExtra(state.extraValue, state.extraType) })
      state.extraKey = ''; state.extraValue = ''; render(); schedulePreview(); void persistPreferences()
    } catch (error) { notify(error.message) }
    return
  }
  if (action === 'remove-extra') { state.extras.splice(Number(button.dataset.index), 1); render(); schedulePreview(); void persistPreferences() }
})

rootEl.addEventListener('change', (event) => {
  const target = event.target
  if (target.matches('[data-field]')) {
    const key = target.dataset.field
    if (key === 'profile') applyProfile(target.value)
    else {
      state[key] = target.type === 'checkbox' ? target.checked : target.value
      void persistPreferences(); render()
      if (state.screen === 'profiles') schedulePreview()
      if (key === 'module') { const workspace = state.workspaces.find((item) => item.id === state.workspaceId); if (workspace) void discover(workspace, target.value) }
    }
  }
  const extraIndex = target.dataset.extraKey ?? target.dataset.extraType ?? target.dataset.extraValue
  if (extraIndex !== undefined) {
    const index = Number(extraIndex)
    if (target.dataset.extraKey !== undefined) state.extras[index].key = target.value
    if (target.dataset.extraType !== undefined) state.extras[index].type = target.value
    if (target.dataset.extraValue !== undefined) {
      try { state.extras[index].value = parseExtra(target.value, state.extras[index].type) }
      catch { state.extras[index].value = target.value }
    }
    void persistPreferences(); schedulePreview()
  }
})

rootEl.addEventListener('input', (event) => {
  const target = event.target
  if (!target.matches('[data-field]')) {
    if (target.dataset.extraKey !== undefined) state.extras[Number(target.dataset.extraKey)].key = target.value
    else if (target.dataset.extraValue !== undefined) state.extras[Number(target.dataset.extraValue)].value = target.value
    else return
    void persistPreferences(); schedulePreview(); return
  }
  state[target.dataset.field] = target.value
  void persistPreferences()
  if (state.screen === 'profiles') schedulePreview()
  if (target.dataset.field === 'profileName') {
    const save = rootEl.querySelector('[data-action="save-profile"]')
    if (save) save.disabled = !state.root || !state.profileName.trim()
  }
})

rootEl.addEventListener('toggle', (event) => {
  if (event.target.matches('details.yaml') && event.target.open) void updatePreview()
}, true)

orca.plugin.on('android.run.progress', handleRunProgress)
orca.plugin.on('android.run.changed', handleRunChanged)
orca.on('theme', () => render())
void hostCall('events.subscribe', { event: 'workspace.changed' }).then(() => orca.on('workspace.changed', () => { void refreshWorkspaces(); void refreshAgentCount() })).catch(() => undefined)
void hostCall('events.subscribe', { event: 'agent.status.changed' }).then(() => orca.on('agent.status.changed', () => void refreshAgentCount())).catch(() => undefined)
render()
void Promise.all([refreshDevices(), refreshWorkspaces(), refreshAgentCount()])
