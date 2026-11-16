import { resolveConfig } from './android/model.ts'
import type { AndroidDevice, AndroidProject, IntentExtra, Profile, ProjectConfig, RunResult } from './android/model.ts'
import type { OrcaFrameApi } from 'orca/frame'
import type { OrcaWorkspace } from './protocol.ts'

declare global {
  interface Window { orca: OrcaFrameApi }
}

interface PanelState {
  workspaces: OrcaWorkspace[]
  workspaceId: string
  root: string
  project: AndroidProject | null
  devices: AndroidDevice[]
  config: ProjectConfig
  module: string
  variant: string
  device: string
  profile: string
  build: boolean
  install: boolean
  clearData: boolean
  activity: string
  launchFlags: string
  extraKey: string
  extraValue: string
  extraType: IntentExtra['type']
  extras: IntentExtra[]
  profileName: string
  running: boolean
  runId: string
  status: string
  result: RunResult | null
}

const state: PanelState = {
  workspaces: [], workspaceId: '', root: '', project: null, devices: [], config: { version: 1 },
  module: '', variant: '', device: '', profile: '', build: true, install: true, clearData: false,
  activity: '', launchFlags: '', extraKey: '', extraValue: '', extraType: 'boolean', extras: [], profileName: '',
  running: false, runId: '', status: 'Ready', result: null
}

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing panel element: ${id}`)
  return element as T
}

function patch(values: Partial<PanelState>): void {
  Object.assign(state, values)
  render()
}

function option(value: string, label: string, disabled = false): HTMLOptionElement {
  const element = document.createElement('option')
  element.value = value
  element.textContent = label
  element.disabled = disabled
  return element
}

function setSelectOptions(select: HTMLSelectElement, options: HTMLOptionElement[], selected: string): void {
  select.replaceChildren(...options)
  select.value = selected
}

function syncValue(id: string, value: string): void {
  const input = document.getElementById(id)
  if ((input instanceof HTMLInputElement || input instanceof HTMLSelectElement) && input.value !== value) input.value = value
}

function render(): void {
  const supported = state.project?.supported === true
  const busy = state.running
  const projectName = $('project-name')
  projectName.textContent = supported
    ? `${(state.module || state.project?.module || ':app').replace(/^:/, '').replace(/:/g, ' · ')} · ${state.project?.applicationId ?? 'applicationId not detected'}`
    : 'No active project'

  const recognition = $('recognition')
  recognition.dataset.supported = String(supported)
  $('recognition-label').textContent = supported ? 'Recognized' : 'Not recognized'
  const emptyMessage = $('empty-message')
  emptyMessage.hidden = supported
  emptyMessage.textContent = state.project?.reason ?? 'Open an Android project workspace to enable Run.'

  const deviceSelect = $<HTMLSelectElement>('device')
  const deviceOptions = state.devices.length
    ? [option('', 'Select device'), ...state.devices.map((device) => option(device.serial, `${device.model} · ${device.serial}`))]
    : [option('', 'No connected devices', true)]
  setSelectOptions(deviceSelect, deviceOptions, state.device)
  deviceSelect.disabled = !supported || busy || !state.devices.length

  const variants = state.project?.variants ?? []
  const debugVariant = variants.find((variant) => variant.toLowerCase() === 'debug')
  const releaseVariant = variants.find((variant) => variant.toLowerCase() === 'release')
  const debugButton = document.querySelector<HTMLButtonElement>('[data-variant="debug"]')!
  const releaseButton = document.querySelector<HTMLButtonElement>('[data-variant="release"]')!
  debugButton.disabled = !supported || busy || !debugVariant
  releaseButton.disabled = !supported || busy || !releaseVariant
  debugButton.setAttribute('aria-pressed', String(state.variant === debugVariant && !!debugVariant))
  releaseButton.setAttribute('aria-pressed', String(state.variant === releaseVariant && !!releaseVariant))
  const additionalVariants = variants.filter((variant) => variant !== debugVariant && variant !== releaseVariant)
  const otherVariantWrap = $('extra-variant-wrap')
  otherVariantWrap.hidden = !additionalVariants.length
  const extraVariantSelect = $<HTMLSelectElement>('extra-variant')
  setSelectOptions(extraVariantSelect, additionalVariants.map((variant) => option(variant, variant)), state.variant)
  extraVariantSelect.disabled = !supported || busy

  const profiles = Object.keys(state.config.profiles ?? {})
  const profileSelect = $<HTMLSelectElement>('profile')
  setSelectOptions(profileSelect, [option('', 'Default'), ...profiles.map((name) => option(name, name.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())))], state.profile)
  profileSelect.disabled = !supported || busy

  $<HTMLInputElement>('build').checked = state.build
  $<HTMLInputElement>('install').checked = state.install
  $<HTMLInputElement>('clear-data').checked = state.clearData
  syncValue('activity', state.activity)
  syncValue('launch-flags', state.launchFlags)
  syncValue('extra-type', state.extraType)
  syncValue('extra-key', state.extraKey)
  syncValue('extra-value', state.extraValue)
  syncValue('profile-name', state.profileName)
  for (const id of ['build', 'install', 'clear-data']) $(id).toggleAttribute('disabled', !supported || busy)
  for (const id of ['activity', 'launch-flags', 'extra-type', 'extra-key', 'extra-value', 'add-extra']) $(id).toggleAttribute('disabled', !supported || busy)
  $('manage-profiles').toggleAttribute('disabled', !supported || busy)
  $('save-profile').toggleAttribute('disabled', !supported || busy || !state.profileName.trim())
  $('profile-name').toggleAttribute('disabled', !supported || busy)

  const runButton = $<HTMLButtonElement>('run')
  runButton.disabled = busy ? false : !supported || !state.device
  $('run-label').textContent = busy ? 'Cancel Run' : 'Run'
  $('run-icon').innerHTML = busy
    ? '<rect x="6" y="6" width="12" height="12" rx="2" />'
    : '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>'
  $('status-badge').textContent = busy ? 'Running' : state.result?.status === 'success' ? 'Ready' : state.result?.status === 'failed' ? 'Failed' : state.result?.status === 'cancelled' ? 'Cancelled' : 'Ready'
  $('status').textContent = state.status
  const hasLogs = !!state.result?.logs.length
  $('logs-toggle').toggleAttribute('disabled', !hasLogs)
  $('logs').textContent = state.result?.logs.join('\n') ?? ''
  const savedProfile = state.profile ? state.config.profiles?.[state.profile] : undefined
  $('save-profile').textContent = savedProfile ? 'Save profile changes' : 'Save profile'

  renderExtras()
}

function renderExtras(): void {
  const list = $('extras-list')
  list.replaceChildren()
  state.extras.forEach((extra, index) => {
    const row = document.createElement('div')
    row.className = 'extra-row'
    const summary = document.createElement('span')
    summary.className = 'extra-summary'
    summary.textContent = `${extra.key}: ${String(extra.value)} (${extra.type})`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'small-button'
    remove.textContent = 'Remove'
    remove.disabled = !state.project?.supported || state.running
    remove.addEventListener('click', () => patch({ extras: state.extras.filter((_, item) => item !== index) }))
    row.append(summary, remove)
    list.append(row)
  })
}

function bindInput<K extends keyof PanelState>(id: string, key: K): void {
  $(id).addEventListener('input', (event) => {
    const element = event.currentTarget as HTMLInputElement | HTMLSelectElement
    patch({ [key]: element.type === 'checkbox' ? (element as HTMLInputElement).checked : element.value } as Pick<PanelState, K>)
  })
  $(id).addEventListener('change', (event) => {
    const element = event.currentTarget as HTMLInputElement | HTMLSelectElement
    patch({ [key]: element.type === 'checkbox' ? (element as HTMLInputElement).checked : element.value } as Pick<PanelState, K>)
  })
}

async function refreshWorkspace(): Promise<void> {
  try {
    const { workspaces, focusedId, focusedName } = await window.orca.plugin.request('android.workspaces')
    const focused = workspaces.find((workspace) => workspace.id === focusedId)
      ?? workspaces.find((workspace) => workspace.name === focusedName)
    patch({ workspaces, workspaceId: focused?.id ?? '' })
    if (focused) await discover(focused)
    else patch({ root: '', project: null, devices: [], config: { version: 1 }, module: '', variant: '', device: '', profile: '', profileName: '', extras: [], running: false, status: 'No active project', result: null })
  } catch (error) {
    patch({ root: '', project: null, devices: [], module: '', variant: '', device: '', running: false, status: (error as Error).message })
  }
}

async function discover(workspace: OrcaWorkspace): Promise<void> {
  const sameWorkspace = state.root === workspace.path
  patch({ workspaceId: workspace.id, root: workspace.path, status: 'Discovering project…', result: null })
  try {
    const { project, devices, config } = await window.orca.plugin.request('android.discover', { root: workspace.path }, { timeoutMs: 120_000 })
    const profileName = sameWorkspace ? state.profile || config.profile || '' : config.profile || ''
    const resolved = resolveConfig(config, profileName)
    const previousVariant = sameWorkspace && project.variants.includes(state.variant) ? state.variant : ''
    const previousDevice = sameWorkspace && devices.some((device) => device.serial === state.device) ? state.device : ''
    patch({
      project, devices, config, profile: profileName, profileName,
      module: resolved?.module || project.module,
      variant: previousVariant || resolved?.variant || project.variants.find((value) => value.toLowerCase() === 'debug') || project.variants[0] || '',
      device: previousDevice || resolved?.device || (devices.length === 1 ? devices[0].serial : ''),
      build: resolved?.build ?? true, install: resolved?.install ?? true, clearData: resolved?.clearData ?? false,
      activity: resolved?.activity ?? '', launchFlags: resolved?.launchFlags ?? '', extras: resolved?.extras ?? [],
      status: project.supported ? (devices.length ? 'Ready' : 'No connected device') : project.reason ?? 'Unsupported project'
    })
  } catch (error) {
    patch({ project: null, devices: [], status: (error as Error).message })
  }
}

function parseExtra(value: string, type: IntentExtra['type']): string | number | boolean {
  if (type === 'string') return value
  if (type === 'boolean') {
    if (value.toLowerCase() !== 'true' && value.toLowerCase() !== 'false') throw new Error('boolean must be true or false')
    return value.toLowerCase() === 'true'
  }
  if (type === 'long') {
    if (!/^-?\d+$/.test(value)) throw new Error('long must be an integer')
    const number = BigInt(value)
    if (number < -(2n ** 63n) || number > 2n ** 63n - 1n) throw new Error('long is outside the signed 64-bit range')
    return number.toString()
  }
  if (!value.trim()) throw new Error(`${type} value is required`)
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Invalid ${type} value`)
  if (type === 'int' && (!Number.isInteger(number) || number < -2_147_483_648 || number > 2_147_483_647)) throw new Error('int must be a 32-bit integer')
  return number
}

async function startRun(): Promise<void> {
  if (!state.project?.supported || !state.device || state.running) return
  const extras = [...state.extras]
  if (state.extraKey.trim()) {
    try { extras.push({ key: state.extraKey.trim(), type: state.extraType, value: parseExtra(state.extraValue, state.extraType) }) }
    catch (error) { patch({ status: (error as Error).message }); return }
  }
  patch({ running: true, status: 'Starting…', result: null })
  try {
    const { runId } = await window.orca.plugin.request('android.run.start', {
      root: state.root, profile: state.profile || undefined,
      options: {
        module: state.module, variant: state.variant, device: state.device,
        build: state.build, install: state.install, clearData: state.clearData,
        activity: state.activity || undefined, launchFlags: state.launchFlags || undefined, extras
      }
    }, { timeoutMs: 120_000 })
    patch({ runId, status: 'Running…' })
  } catch (error) {
    patch({ running: false, status: (error as Error).message })
  }
}

async function cancelRun(): Promise<void> {
  if (!state.runId) return
  try {
    await window.orca.plugin.request('android.run.cancel', { runId: state.runId })
    patch({ status: 'Cancelling…' })
  } catch (error) { patch({ status: (error as Error).message }) }
}

async function saveProfile(): Promise<void> {
  const workspace = state.workspaces.find((item) => item.id === state.workspaceId)
  const name = state.profileName.trim()
  if (!workspace || !name) return
  const extras = [...state.extras]
  if (state.extraKey.trim()) {
    try { extras.push({ key: state.extraKey.trim(), type: state.extraType, value: parseExtra(state.extraValue, state.extraType) }) }
    catch (error) { patch({ status: (error as Error).message }); return }
  }
  const profile: Profile = {
    module: state.module, variant: state.variant, device: state.device,
    build: state.build, install: state.install, clearData: state.clearData,
    activity: state.activity || undefined, launchFlags: state.launchFlags || undefined, extras
  }
  try {
    await window.orca.plugin.request('android.profile.save', { root: state.root, name, profile })
    patch({ profile: name, status: 'Profile saved' })
    $<HTMLDialogElement>('profile-dialog').close()
    await discover(workspace)
  } catch (error) { patch({ status: (error as Error).message }) }
}

function bind(): void {
  bindInput('device', 'device')
  bindInput('extra-variant', 'variant')
  bindInput('profile', 'profile')
  bindInput('build', 'build')
  bindInput('install', 'install')
  bindInput('clear-data', 'clearData')
  bindInput('activity', 'activity')
  bindInput('launch-flags', 'launchFlags')
  bindInput('extra-type', 'extraType')
  bindInput('extra-key', 'extraKey')
  bindInput('extra-value', 'extraValue')
  bindInput('profile-name', 'profileName')

  $('device').addEventListener('change', () => patch({ device: $<HTMLSelectElement>('device').value }))
  $('profile').addEventListener('change', () => {
    const profile = $<HTMLSelectElement>('profile').value
    const resolved = resolveConfig(state.config, profile)
    patch({
      profile, profileName: profile, module: resolved?.module ?? state.project?.module ?? '',
      variant: resolved?.variant ?? state.project?.variants.find((item) => item.toLowerCase() === 'debug') ?? state.project?.variants[0] ?? '',
      device: resolved?.device ?? (state.devices.length === 1 ? state.devices[0].serial : ''),
      build: resolved?.build ?? true, install: resolved?.install ?? true, clearData: resolved?.clearData ?? false,
      activity: resolved?.activity ?? '', launchFlags: resolved?.launchFlags ?? '', extras: resolved?.extras ?? []
    })
  })
  document.querySelectorAll<HTMLButtonElement>('[data-variant]').forEach((button) => button.addEventListener('click', () => {
    const variant = button.dataset.variant === 'release'
      ? state.project?.variants.find((item) => item.toLowerCase() === 'release')
      : state.project?.variants.find((item) => item.toLowerCase() === 'debug')
    if (variant) patch({ variant })
  }))

  $('manage-profiles').addEventListener('click', () => $<HTMLDialogElement>('profile-dialog').showModal())
  $('close-profile-dialog').addEventListener('click', () => $<HTMLDialogElement>('profile-dialog').close())
  $('cancel-profile').addEventListener('click', () => $<HTMLDialogElement>('profile-dialog').close())
  $('save-profile').addEventListener('click', () => void saveProfile())
  $('refresh').addEventListener('click', () => void refreshWorkspace())
  $('run').addEventListener('click', () => void (state.running ? cancelRun() : startRun()))
  $('add-extra').addEventListener('click', () => {
    if (!state.extraKey.trim()) return
    try { patch({ extras: [...state.extras, { key: state.extraKey.trim(), type: state.extraType, value: parseExtra(state.extraValue, state.extraType) }], extraKey: '', extraValue: '' }) }
    catch (error) { patch({ status: (error as Error).message }) }
  })
  $('logs-toggle').addEventListener('click', () => {
    $('logs').hidden = !$('logs').hidden
  })

  window.orca.plugin.on('android.run.changed', ({ runId, status, result }) => {
    if (runId !== state.runId) return
    patch({
      running: status === 'running',
      status: result?.error?.message ?? (status === 'success' ? 'Ready' : status === 'failed' ? 'Run failed' : status === 'cancelled' ? 'Cancelled' : 'Running…'),
      result: result ?? state.result
    })
  })
  void window.orca.host.call('events.subscribe', { event: 'workspace.changed' }).then(() => {
    window.orca.on('workspace.changed', () => void refreshWorkspace())
  }).catch(() => undefined)
}

bind()
render()
void refreshWorkspace()
