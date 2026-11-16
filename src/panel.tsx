import {
  atom, Badge, Button, Checkbox, CodeView, Grid, Heading, host, IconButton, Input, on, plugin, read, Row, Select, Stack, Text, update,
  type PanelContext
} from 'orca'
import { resolveConfig } from './android/model.ts'
import type { AndroidDevice, AndroidProject, IntentExtra, Profile, ProjectConfig, RunOptions, RunResult } from './android/model.ts'
import type { OrcaWorkspace } from './protocol.ts'

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
  install: boolean
  clearData: boolean
  activity: string
  uri: string
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
  showLogs: boolean
  profileScreen: boolean
  buildLogs: string[]
  runLogs: string[]
  agentCount: number | null
  devicesLoading: boolean
  projectLoading: boolean
}

type ProjectPreferences = Pick<PanelState, 'profile' | 'profileName' | 'module' | 'variant' | 'device' | 'install' | 'clearData' | 'activity' | 'uri' | 'launchFlags' | 'extraKey' | 'extraValue' | 'extraType' | 'extras'>
const preferenceKeys: (keyof ProjectPreferences)[] = ['profile', 'profileName', 'module', 'variant', 'device', 'install', 'clearData', 'activity', 'uri', 'launchFlags', 'extraKey', 'extraValue', 'extraType', 'extras']
const projectPreferences = atom('android-devtools.project-preferences.v1', {} as Record<string, ProjectPreferences>, { persist: 'plugin', version: 1 })

const state = atom<PanelState>({
  workspaces: [], workspaceId: '', root: '', project: null, devices: [], config: { version: 1 },
  module: '', variant: '', device: '', profile: '', install: true, clearData: false,
  activity: '', uri: '', launchFlags: '', extraKey: '', extraValue: '', extraType: 'boolean', extras: [], profileName: '',
  running: false, runId: '', status: 'Ready', result: null, showLogs: false, profileScreen: false, buildLogs: [], runLogs: [], agentCount: null, devicesLoading: false, projectLoading: false
})

let workspaceRefreshGeneration = 0
let discoveryGeneration = 0
let deviceGeneration = 0

async function refreshDevices(force = false): Promise<void> {
  const generation = ++deviceGeneration
  patchState({ devicesLoading: true })
  try {
    const { devices } = await plugin.request('android.devices', { ...(force ? { refresh: true } : {}) })
    if (generation !== deviceGeneration) return
    const current = read(state)
    const online = devices.filter((device) => device.state === 'device')
    const stillSelected = online.some((device) => device.serial === current.device)
    patchState({ devices, device: stillSelected ? current.device : online.length === 1 ? online[0].serial : '', devicesLoading: false })
  } catch {
    if (generation === deviceGeneration) patchState({ devicesLoading: false })
  }
}

function patchState(values: Partial<PanelState>): void {
  const current = read(state)
  update(state, (previous) => ({ ...previous, ...values }))
  if (current.project?.root && preferenceKeys.some((key) => Object.prototype.hasOwnProperty.call(values, key))) {
    const next = { ...current, ...values }
    const preferences = Object.fromEntries(preferenceKeys.map((key) => [key, next[key]])) as ProjectPreferences
    const workspacePath = current.workspaces.find((workspace) => workspace.id === current.workspaceId)?.path
    update(projectPreferences, (all) => ({ ...all, [current.project!.root]: preferences, ...(workspacePath ? { [workspacePath]: preferences } : {}) }))
  }
}

async function refreshWorkspaces(preferFocused = false, forceRefresh = false): Promise<void> {
  const generation = ++workspaceRefreshGeneration
  try {
    const { workspaces, focusedId, focusedName } = await plugin.request('android.workspaces')
    if (generation !== workspaceRefreshGeneration) return
    const current = read(state)
    const focused = workspaces.find((workspace) => workspace.id === focusedId) ?? workspaces.find((workspace) => workspace.name === focusedName)
    const focusedWorkspaceId = workspaces.some((workspace) => workspace.id === focusedId) ? focusedId : focused?.id
    const workspaceStillExists = workspaces.some((workspace) => workspace.id === current.workspaceId)
    const workspaceId = (preferFocused ? focusedWorkspaceId : workspaceStillExists ? current.workspaceId : '') || focusedWorkspaceId || (workspaces.length === 1 ? workspaces[0].id : '')
    patchState({ workspaces, workspaceId })
    const selected = workspaces.find((workspace) => workspace.id === workspaceId)
    if (selected) await discover(selected, undefined, forceRefresh)
      else {
        ++discoveryGeneration
        patchState({ root: '', project: null, projectLoading: false, config: { version: 1 }, device: '', module: '', variant: '', profile: '', status: 'No active project', result: null })
        void refreshDevices()
      }
  } catch (error) {
    if (generation !== workspaceRefreshGeneration) return
    const message = (error as Error).message
    patchState({ root: '', project: null, projectLoading: false, status: message })
  }
}

async function discover(workspace: OrcaWorkspace, module?: string, forceRefresh = false): Promise<void> {
  const generation = ++discoveryGeneration
  const preferences = read(projectPreferences)[workspace.path]
  const requestedModule = module ?? preferences?.module
  patchState({ workspaceId: workspace.id, root: workspace.path, project: null, projectLoading: true, status: forceRefresh ? 'Refreshing project…' : 'Discovering project…', result: null })
  try {
    const { project, devices, config } = await plugin.request('android.discover', { root: workspace.path, ...(requestedModule ? { module: requestedModule } : {}), ...(forceRefresh ? { refresh: true } : {}) }, { timeoutMs: 120_000 })
    if (generation !== discoveryGeneration) return
    const remembered = read(projectPreferences)[project.root] ?? preferences
    const rememberedProfile = remembered?.profile ?? ''
    const profileName = remembered
      ? rememberedProfile && config.profiles?.[rememberedProfile] ? rememberedProfile : rememberedProfile ? config.profile ?? '' : ''
      : config.profile ?? ''
    const profile = resolveConfig(config, profileName)
    const moduleName = (module && project.modules.includes(module) ? module : undefined) || (remembered?.module && project.modules.includes(remembered.module) ? remembered.module : undefined) || profile?.module || project.module
    const base = {
      profile: profileName, profileName, module: moduleName,
      variant: profile?.variant || project.variants.find((value) => value.toLowerCase() === 'debug') || project.variants[0] || '',
      device: profile?.device || (devices.length === 1 ? devices[0].serial : ''),
      install: profile?.install ?? true, clearData: profile?.clearData ?? false,
      activity: profile?.activity ?? '', uri: profile?.uri ?? '', launchFlags: profile?.launchFlags ?? '', extras: profile?.extras ?? []
    }
    const restored: ProjectPreferences = remembered ? { ...base, ...remembered, module: moduleName } : base
    const validProfile = restored.profile && config.profiles?.[restored.profile] ? restored.profile : profileName
    patchState({
      ...restored, profile: validProfile, profileName: remembered?.profileName ?? validProfile,
      root: project.root, project, devices, config, projectLoading: false,
      variant: project.variants.includes(restored.variant) ? restored.variant : base.variant,
      device: devices.some((device) => device.serial === restored.device && device.state === 'device') ? restored.device : (devices.filter((device) => device.state === 'device').length === 1 ? devices.find((device) => device.state === 'device')?.serial ?? '' : ''),
      status: project.supported ? (devices.some((device) => device.state === 'device') ? 'Ready' : 'No online device') : (project.reason ?? 'Unsupported project'),
    })
    if (!remembered && project.supported) {
      const initialPreferences = { ...restored, profile: validProfile, profileName: validProfile }
      update(projectPreferences, (all) => ({ ...all, [project.root]: initialPreferences, [workspace.path]: initialPreferences }))
    }
  } catch (error) {
    if (generation !== discoveryGeneration) return
    const message = (error as Error).message
    patchState({ project: null, projectLoading: false, status: message })
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
    try {
      const number = BigInt(value)
      if (number < -(2n ** 63n) || number > 2n ** 63n - 1n) throw new Error('long is outside the signed 64-bit range')
      return number.toString()
    } catch { throw new Error('long must be a signed 64-bit integer') }
  }
  if (!value.trim()) throw new Error(`${type} value is required`)
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Invalid ${type} value`)
  if (type === 'int' && (!Number.isInteger(number) || number < -2_147_483_648 || number > 2_147_483_647)) throw new Error('int must be a 32-bit integer')
  return number
}

async function startRun(): Promise<void> {
  const current = read(state)
  if (!current.project?.supported || !current.device || current.running) return
  let extras = [...current.extras]
  if (current.extraKey.trim()) {
    try { extras.push({ key: current.extraKey.trim(), type: current.extraType, value: parseExtra(current.extraValue, current.extraType) }) }
    catch (error) { patchState({ status: (error as Error).message }); return }
  }
  patchState({ running: true, status: 'Starting…', result: null, buildLogs: [], runLogs: [] })
  try {
    const { runId } = await plugin.request('android.run.start', {
      root: current.root, ...(current.profile ? { profile: current.profile } : {}),
      options: {
        module: current.module, variant: current.variant, device: current.device,
        build: true, install: current.install, clearData: current.clearData,
        ...(current.activity ? { activity: current.activity } : {}),
        ...(current.uri ? { uri: current.uri } : {}),
        ...(current.launchFlags ? { launchFlags: current.launchFlags } : {}), extras
      }
    }, { timeoutMs: 120_000 })
    patchState({ runId, status: 'Running…' })
  } catch (error) {
    const message = (error as Error).message
    patchState({ running: false, status: message, runLogs: [...read(state).runLogs, `Run request failed: ${message}`].slice(-200) })
  }
}

async function cancelRun(): Promise<void> {
  const runId = read(state).runId
  if (!runId) return
  await plugin.request('android.run.cancel', { runId })
  patchState({ status: 'Cancelling…' })
}

async function copyRunError(): Promise<void> {
  const current = read(state)
  const text = [current.result?.error?.message, ...current.buildLogs, ...current.runLogs].filter(Boolean).join('\n')
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable')
    await navigator.clipboard.writeText(text)
    patchState({ status: 'Error copied' })
  } catch {
    patchState({ status: 'Could not copy error; select the log text to copy it.' })
  }
}

async function copyLog(kind: 'build' | 'run'): Promise<void> {
  const current = read(state)
  const text = (kind === 'build' ? current.buildLogs : current.runLogs).join('\n')
  try {
    if (!text) throw new Error('No log output to copy')
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable')
    await navigator.clipboard.writeText(text)
    patchState({ status: `${kind === 'build' ? 'Build' : 'Run'} log copied` })
  } catch (error) { patchState({ status: (error as Error).message }) }
}

async function sendLogToAgent(kind: 'build' | 'run'): Promise<void> {
  const current = read(state)
  const text = (kind === 'build' ? current.buildLogs : current.runLogs).join('\n')
  if (!text) { patchState({ status: `No ${kind} log output to send` }); return }
  try {
    await plugin.request('android.agent.sendLog', { text: `Android Devtools ${kind} log:\n\n${text}` })
    patchState({ status: `${kind === 'build' ? 'Build' : 'Run'} log inserted in agent input` })
  } catch (error) { patchState({ status: (error as Error).message }) }
}

async function refreshAgentCount(): Promise<void> {
  try {
    const { count } = await plugin.request('android.agent.status')
    patchState({ agentCount: count })
  } catch { patchState({ agentCount: 0 }) }
}

async function saveSelectedProfile(): Promise<void> {
  const current = read(state)
  if (!current.profileName.trim()) { patchState({ status: 'Enter a profile name' }); return }
  const extras = [...current.extras]
  if (current.extraKey.trim()) {
    try { extras.push({ key: current.extraKey.trim(), type: current.extraType, value: parseExtra(current.extraValue, current.extraType) }) }
    catch (error) { patchState({ status: (error as Error).message }); return }
  }
  const profile: Profile = {
    module: current.module, variant: current.variant, device: current.device,
    build: true, install: current.install, clearData: current.clearData,
    ...(current.activity ? { activity: current.activity } : {}),
    ...(current.uri ? { uri: current.uri } : {}),
    ...(current.launchFlags ? { launchFlags: current.launchFlags } : {}), extras
  }
  try {
    await plugin.request('android.profile.save', { root: current.root, name: current.profileName.trim(), profile })
    patchState({ profile: current.profileName.trim(), status: 'Profile saved' })
    const workspace = current.workspaces.find((workspace) => workspace.id === current.workspaceId)
    if (workspace) await discover(workspace)
  } catch (error) { patchState({ status: (error as Error).message }) }
}

async function deleteSelectedProfile(): Promise<void> {
  const current = read(state)
  if (!current.profile || !current.root) return
  try {
    const result = await plugin.request('android.profile.delete', { root: current.root, name: current.profile })
    const message = result.deleted ? `Deleted profile '${current.profile}'.` : `Profile '${current.profile}' was not found.`
    patchState({ profile: '', profileName: '', status: message })
    const workspace = current.workspaces.find((workspace) => workspace.id === current.workspaceId)
    if (workspace) await discover(workspace)
  } catch (error) {
    const message = (error as Error).message
    patchState({ status: message })
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('android.run.progress', ({ runId, stage, message }) => {
    const current = read(state)
    if (runId !== current.runId) return
    const entry = `${stage}: ${message}`
    patchState(stage === 'build'
      ? { status: message, buildLogs: [...current.buildLogs, entry].slice(-200) }
      : { status: message, runLogs: [...current.runLogs, entry].slice(-200) })
  }))
  ctx.subscriptions.push(plugin.on('android.run.changed', ({ runId, status, result }) => {
    if (runId !== read(state).runId) return
    const current = read(state)
    patchState({
      running: status === 'running',
      status: result?.error?.message ?? (status === 'success' ? 'Ready' : status === 'failed' ? 'Run failed' : status === 'cancelled' ? 'Cancelled' : 'Running…'),
      result: result ?? current.result,
      buildLogs: result?.buildLogs ?? current.buildLogs,
      runLogs: result?.runLogs ?? current.runLogs
    })
  }))
  void refreshAgentCount()
  void refreshDevices()
  void host.call('events.subscribe', { event: 'workspace.changed' }).then(() => {
    ctx.subscriptions.push(on('workspace.changed', () => { void refreshWorkspaces(true); void refreshAgentCount() }))
  }).catch(() => undefined)
  void host.call('events.subscribe', { event: 'agent.status.changed' }).then(() => {
    ctx.subscriptions.push(on('agent.status.changed', () => void refreshAgentCount()))
  }).catch(() => undefined)
  void refreshWorkspaces(true)
}

function applyProfileSelection(selectedProfile: string): void {
  const current = read(state)
  const profileName = selectedProfile === 'default' ? '' : selectedProfile
  const selected = resolveConfig(current.config, profileName)
  const project = current.project
  const variants = project?.variants ?? []
  patchState({
    profile: profileName, profileName,
    module: selected?.module ?? project?.module ?? '',
    variant: selected?.variant ?? variants.find((item) => item.toLowerCase() === 'debug') ?? variants[0] ?? (project?.supported ? '' : current.variant || 'Debug'),
    device: selected?.device ?? (current.devices.length === 1 ? current.devices[0].serial : ''),
    install: selected?.install ?? true, clearData: selected?.clearData ?? false,
    activity: selected?.activity ?? '', uri: selected?.uri ?? '', launchFlags: selected?.launchFlags ?? '', extras: selected?.extras ?? []
  })
}

export default function Panel() {
  const value = read(state)
  const project = value.project
  const unsupported = !project?.supported
  const profileOptions = [{ value: 'default', label: 'Default' }, ...Object.keys(value.config.profiles ?? {}).map((name) => ({ value: name, label: name }))]
  const variants = project?.variants ?? []
  const debugVariant = variants.find((variant) => variant.toLowerCase() === 'debug')
  const releaseVariant = variants.find((variant) => variant.toLowerCase() === 'release')
  const debugChoice = debugVariant
  const releaseChoice = releaseVariant
  const extraVariants = variants.filter((variant) => variant !== debugVariant && variant !== releaseVariant)
  const busy = value.running
  const savedProfile = value.profile ? value.config.profiles?.[value.profile] : undefined
  const segmentValue = value.variant.toLowerCase() === (releaseVariant ?? 'Release').toLowerCase() ? 'release' : 'debug'
  const onlineDevices = value.devices.filter((device) => device.state === 'device')
  const deviceOptions = value.devices.length
    ? value.devices.map((device) => ({ value: device.serial, label: `${device.model} · ${device.serial}${device.state !== 'device' ? ` (${device.state})` : ''}`, disabled: device.state !== 'device' }))
    : [{ value: 'no-device', label: value.devicesLoading ? 'Searching for devices…' : 'No ADB devices found', disabled: true }]
  const runDisabled = busy || value.projectLoading || !project?.supported || !onlineDevices.some((device) => device.serial === value.device) || !value.variant
  const runReason = value.projectLoading ? 'Detecting Android project…' : !project?.supported ? project?.reason ?? 'No Android application module detected in the focused project.' : !onlineDevices.length ? value.devices.some((device) => device.state === 'unauthorized') ? 'Authorize USB debugging on the device.' : value.devices.some((device) => device.state === 'offline') ? 'Reconnect the offline device.' : 'Connect a device or start an emulator.' : !value.device ? 'Select an online device.' : !value.variant ? 'Select an available build variant.' : ''
  const operationMessage = busy ? value.status : value.result?.error?.message ?? (value.result?.status === 'success' ? 'Run completed' : value.result?.status === 'cancelled' ? 'Operation cancelled' : runDisabled ? runReason : 'Ready to run')
  if (value.profileScreen) return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Heading level={3}>Profile manager</Heading>
        <IconButton icon="close" label="Back to Android Run" tooltip="Back" variant="ghost" size="xs" onPress={() => patchState({ profileScreen: false })} />
      </Row>
      <Select label="Profile" value={value.profile || 'default'} options={profileOptions} disabled={busy || !value.root} onChange={applyProfileSelection} />
      <Input label="Profile name" value={value.profileName} placeholder={value.profile || 'e.g. premium-ads'} disabled={busy || !value.root} onChange={(profileName) => patchState({ profileName })} />
      <Text size="xs" muted>Launch options saved in .android-devtools.yaml</Text>
      <Input label="Activity (optional)" value={value.activity} placeholder="Launcher Activity" disabled={busy || !value.root} onChange={(activity) => patchState({ activity })} />
      <Input label="Intent data URI (optional)" value={value.uri} placeholder="myapp://premium" disabled={busy || !value.root} onChange={(uri) => patchState({ uri })} />
      <Input label="Launch flags" value={value.launchFlags} placeholder="0x10000000" disabled={busy || !value.root} onChange={(launchFlags) => patchState({ launchFlags })} />
      <Text size="xs" muted>Intent extras passed to the app when it launches.</Text>
      <Select label="Extra type" value={value.extraType} options={['string', 'boolean', 'int', 'long', 'float', 'double'].map((type) => ({ value: type, label: type }))} disabled={busy || !value.root} onChange={(extraType) => patchState({ extraType: extraType as IntentExtra['type'] })} />
      <Input label="Extra key" value={value.extraKey} placeholder="debug_premium_ads" disabled={busy || !value.root} onChange={(extraKey) => patchState({ extraKey })} />
      <Input label="Extra value" value={value.extraValue} placeholder="true" disabled={busy || !value.root} onChange={(extraValue) => patchState({ extraValue })} />
      {value.extras.map((extra, index) => <Row key={`${extra.key}-${index}`} justify="between"><Text size="xs" truncate>{extra.key}: {String(extra.value)} ({extra.type})</Text><Button size="xs" variant="ghost" disabled={busy} onPress={() => patchState({ extras: value.extras.filter((_, item) => item !== index) })}>Remove</Button></Row>)}
      <Button size="xs" variant="outline" disabled={!value.extraKey.trim() || busy || !value.root} onPress={() => {
        try { patchState({ extras: [...value.extras, { key: value.extraKey.trim(), type: value.extraType, value: parseExtra(value.extraValue, value.extraType) }], extraKey: '', extraValue: '' }) }
        catch (error) { patchState({ status: (error as Error).message }) }
      }}>Add Extra</Button>
      <Button size="xs" variant="solid" disabled={!value.profileName.trim() || busy || !value.root} onPress={() => void saveSelectedProfile()}>{savedProfile ? 'Save profile changes' : 'Save profile'}</Button>
      <Button size="xs" variant="ghost" tone="danger" disabled={!value.profile || busy || !value.root} onPress={() => void deleteSelectedProfile()}>Delete selected profile</Button>
      <Text size="xs" muted>{value.status}</Text>
    </Stack>
  )
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Heading level={3}>Android Run</Heading>
        <IconButton icon="settings" label="Open Profile manager" tooltip="Profile manager" variant="ghost" size="xs" disabled={busy} onPress={() => patchState({ profileScreen: true })} />
      </Row>
      <Row justify="between" align="center" gap="xs">
        <Text size="xs" muted truncate>{project?.supported ? `${(value.module || project.module || 'Module').replace(/^:/, '').replace(/:/g, ' · ')} · ${project.applicationId ?? 'applicationId not detected'}` : value.projectLoading ? 'Detecting Android project…' : value.root ? 'No Android application module detected' : 'No active project'}</Text>
        <Row gap="xs" align="center">
          <Badge tone={project?.supported ? 'success' : value.projectLoading ? 'accent' : 'warning'}>{project?.supported ? 'Project ready' : value.projectLoading ? 'Detecting project' : 'Project not recognized'}</Badge>
          <IconButton icon="refresh" label="Refresh project and devices" tooltip="Refresh project and devices" variant="ghost" size="xs" disabled={busy} onPress={() => void refreshWorkspaces(false, true)} />
        </Row>
      </Row>
      {project?.supported && project.modules.length > 1 && <Select label="App module" value={value.module} options={project.modules.map((module) => ({ value: module, label: module.replace(/^:/, '').replace(/:/g, ' · ') }))} disabled={busy} onChange={(module) => { const workspace = value.workspaces.find((item) => item.id === value.workspaceId); if (workspace) void discover(workspace, module) }} />}
        <Row align="end" gap="xs"><Select label="Device" value={value.device || (value.devices.length ? '' : 'no-device')} placeholder="Select device" options={deviceOptions} disabled={busy || !onlineDevices.length} onChange={(device) => patchState({ device })} /><IconButton icon="refresh" label="Refresh devices" tooltip="Refresh devices" variant="ghost" size="xs" disabled={busy || value.devicesLoading} onPress={() => void refreshDevices(true)} /></Row>
      {value.devices.some((device) => device.state !== 'device') && <Text muted size="xs">{value.devices.filter((device) => device.state !== 'device').map((device) => `${device.model}: ${device.state === 'unauthorized' ? 'authorize USB debugging' : 'reconnect device'}`).join(' · ')}</Text>}
        <Stack gap="xs">
          <Text size="xs" muted>Variant</Text>
          <Grid columns={2} gap="xs">
            <Button variant={segmentValue === 'debug' ? 'solid' : 'ghost'} tone="neutral" disabled={!debugChoice || busy || unsupported} onPress={() => debugChoice && patchState({ variant: debugChoice })}>Debug</Button>
            <Button variant={segmentValue === 'release' ? 'solid' : 'ghost'} tone="neutral" disabled={!releaseChoice || busy || unsupported} onPress={() => releaseChoice && patchState({ variant: releaseChoice })}>Release</Button>
          </Grid>
          {extraVariants.length > 0 && <Select label="Other variant" labelHidden value={extraVariants.includes(value.variant) ? value.variant : ''} placeholder="Other variant…" options={extraVariants.map((variant) => ({ value: variant, label: variant }))} disabled={busy || unsupported} onChange={(variant) => patchState({ variant })} />}
        </Stack>
        <Select label="Profile" value={value.profile || 'default'} options={profileOptions} disabled={busy || unsupported} onChange={applyProfileSelection} />
        <Checkbox label="Install APK" checked={value.install} disabled={busy || unsupported} onChange={(install) => patchState({ install })} />
        <Checkbox label="Clear App Data" checked={value.clearData} disabled={busy || unsupported} onChange={(clearData) => patchState({ clearData })} />
      <Grid columns={1} gap="none">
        <Button size="md" variant="solid" tone="accent" icon={busy ? 'stop' : 'play'} disabled={!busy && runDisabled} tooltip={!busy && runDisabled ? runReason : undefined} onPress={() => busy ? void cancelRun() : void startRun()}>{busy ? 'Cancel Run' : 'Run'}</Button>
      </Grid>
      <Row justify="between" align="center">
        <Row gap="xs" align="center"><Badge tone={busy ? 'accent' : value.result?.status === 'failed' ? 'danger' : value.result?.status === 'success' ? 'success' : 'neutral'}>{busy ? 'Running' : value.result?.status === 'success' ? 'Success' : value.result?.status === 'failed' ? 'Failed' : value.result?.status === 'cancelled' ? 'Cancelled' : 'Idle'}</Badge><Text size="xs" muted>{operationMessage}</Text></Row>
        <Row gap="xs" align="center">
          <Button size="xs" variant="ghost" onPress={() => patchState({ showLogs: !value.showLogs })}>{value.showLogs ? 'Hide logs' : 'Show logs'}</Button>
          <Button size="xs" variant="ghost" disabled={!value.buildLogs.length && !value.runLogs.length} onPress={() => patchState({ buildLogs: [], runLogs: [], result: null })}>Clear log</Button>
        </Row>
      </Row>
      {value.result && <Text size="xs" muted>{value.result.durationMs} ms · exit {value.result.exitCode ?? '—'}</Text>}
      {value.result?.status === 'failed' && <Button size="xs" icon="copy" variant="outline" onPress={() => void copyRunError()}>Copy error</Button>}
      {value.showLogs && <Stack gap="xs">
        <Text size="xs" weight="semibold">Build log</Text>
        <CodeView label="Build log output" code={value.buildLogs.join('\n') || 'No build output yet.'} language="text" wrap maxHeight="md" />
        <Row gap="xs" wrap>
          <Button size="xs" icon="copy" variant="outline" disabled={!value.buildLogs.length} onPress={() => void copyLog('build')}>Copy build log</Button>
          <Button size="xs" icon="agent" variant="outline" disabled={!value.buildLogs.length || value.agentCount !== 1} onPress={() => void sendLogToAgent('build')}>Send to agent</Button>
        </Row>
        <Text size="xs" weight="semibold">Run log</Text>
        <CodeView label="Run log output" code={value.runLogs.join('\n') || 'No run output yet.'} language="text" wrap maxHeight="md" />
        <Row gap="xs" wrap>
          <Button size="xs" icon="copy" variant="outline" disabled={!value.runLogs.length} onPress={() => void copyLog('run')}>Copy run log</Button>
          <Button size="xs" icon="agent" variant="outline" disabled={!value.runLogs.length || value.agentCount !== 1} onPress={() => void sendLogToAgent('run')}>Send to agent</Button>
        </Row>
        <Text size="xs" muted>{value.agentCount === 1 ? 'Log inserts into the sole agent input; press Enter there to submit.' : 'Sending requires exactly one agent terminal in the focused workspace.'}</Text>
      </Stack>}
    </Stack>
  )
}
