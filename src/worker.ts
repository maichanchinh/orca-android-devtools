import type { OrcaWorkerApi } from 'orca/worker'
import { discoverDevices, discoverProject } from './android/discovery.ts'
import { deleteProfile, readProjectConfig, saveProfile } from './android/config.ts'
import { AsyncTtlCache, PersistentCache } from './android/cache.ts'
import { cancelRun, executeRun } from './android/runner.ts'
import { completeRunOptions, resolveConfig } from './android/model.ts'
import type { Profile, RunOptions, RunResult } from './android/model.ts'
import type { OrcaWorkspace } from './protocol.ts'

const results = new Map<string, RunResult>()
const cacheTtlMs = 30_000
const deviceCache = new AsyncTtlCache<Awaited<ReturnType<typeof discoverDevices>>>(cacheTtlMs)

function decodeProject(value: unknown): Awaited<ReturnType<typeof discoverProject>> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const project = value as Partial<Awaited<ReturnType<typeof discoverProject>>>
  if (typeof project.root !== 'string' || typeof project.module !== 'string' || !Array.isArray(project.modules) || !project.modules.every((item) => typeof item === 'string') || !Array.isArray(project.variants) || !project.variants.every((item) => typeof item === 'string') || typeof project.gradleWrapper !== 'string' || typeof project.androidCli !== 'boolean' || typeof project.supported !== 'boolean') return undefined
  return project as Awaited<ReturnType<typeof discoverProject>>
}

function log(orca: OrcaWorkerApi, message: string, detailed = false): void {
  if (!detailed || process.env.ANDROID_DEVTOOLS_DEBUG === '1') {
    orca.log(`[android-devtools] ${message}`)
    orca.panels.post('android.log', { message, at: Date.now() })
  }
}

export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export default function activate(orca: OrcaWorkerApi): void {
  const projectCache = new PersistentCache(orca.storage, 'android-devtools.project.v1', decodeProject)
  orca.panels.handle('android.workspaces', async () => {
    const [listed, context] = await Promise.all([
      orca.host.call('workspace.list'),
      orca.host.call('workspace.readContext')
    ])
    const workspaces = listed.workspaces.filter((workspace) => workspace.hostId === 'local' || workspace.hostId === null || workspace.hostId === undefined) as OrcaWorkspace[]
    return { workspaces, focusedId: context?.workspaceId ?? null, focusedName: context?.displayName ?? null }
  })

  orca.panels.handle('android.discover', async ({ root, module, refresh }: { root: string; module?: string; refresh?: boolean }) => {
    const startedAt = Date.now()
    const projectKey = `${root}\u0000${module ?? ''}`
    let projectSource = 'loaded'
    const devicesWereCached = !refresh && deviceCache.has('local-adb')
    try {
      const [cachedProject, devices] = await Promise.all([
        projectCache.get(projectKey, () => discoverProject(root, module), !!refresh),
        deviceCache.get('local-adb', () => discoverDevices(root), !!refresh)
      ])
      const project = cachedProject.value
      projectSource = cachedProject.source
      const config = await readProjectConfig(project.root)
      log(orca, `discover ${root}: ${project.supported ? 'supported' : 'unsupported'}, ${devices.length} device(s), ${Date.now() - startedAt}ms; cache project=${projectSource}, devices=${refresh ? 'refreshed' : devicesWereCached ? 'hit' : 'miss'}${refresh ? ', refreshed' : ''}`)
      log(orca, `discover request key ${projectKey}`, true)
      return jsonSafe({ project, devices, config })
    } catch (error) {
      log(orca, `discover failed for ${root}: ${(error as Error).message}`)
      throw error
    }
  })

  orca.panels.handle('android.profile.save', async ({ root, name, profile }: { root: string; name: string; profile: Profile }) => {
    await saveProfile(root, name, profile)
    log(orca, `saved profile '${name}' in ${root}`)
    return { ok: true as const }
  })

  orca.panels.handle('android.profile.delete', async ({ root, name }: { root: string; name: string }) => {
    const deleted = await deleteProfile(root, name)
    log(orca, `deleted profile '${name}' in ${root}: ${deleted}`)
    return { ok: true as const, deleted }
  })

  orca.panels.handle('android.run.start', async ({ root, profile, options }: { root: string; profile?: string; options: Partial<RunOptions> }, { signal }) => {
    const { value: project } = await projectCache.get(`${root}\u0000${options.module ?? ''}`, () => discoverProject(root, options.module))
    if (!project.supported) throw Object.assign(new Error(project.reason ?? 'Unsupported Android project'), { code: 'unsupported_project' })
    const config = await readProjectConfig(project.root)
    const merged = resolveConfig(config, profile, options)
    const devices = await discoverDevices(project.root)
    const selectedDevice = merged.device || (devices.length === 1 ? devices[0].serial : '')
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const resolved = completeRunOptions(project, devices, { ...merged, device: selectedDevice })
    results.delete(runId)
    log(orca, `run ${runId} started: ${resolved.module} ${resolved.variant} on ${resolved.device}`)
    orca.panels.post('android.run.changed', { runId, status: 'running' })
    void executeRun(project.root, runId, resolved, signal, (progress) => {
      orca.log(`[android-devtools] ${runId} ${progress.stage}: ${progress.message}`)
      orca.panels.post('android.run.progress', { runId, ...progress })
    }).then((result) => {
      results.set(runId, result)
      log(orca, `run ${runId} ${result.status} after ${result.durationMs}ms${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}`)
      if (result.logs.length) log(orca, `run ${runId} output:\n${result.logs.join('\n')}`, true)
      orca.panels.post('android.run.changed', { runId, status: result.status, result })
    })
    return { runId }
  })

  orca.panels.handle('android.run.cancel', async ({ runId }: { runId: string }) => ({ cancelled: cancelRun(runId) }))
  orca.panels.handle('android.run.result', async ({ runId }: { runId: string }) => ({ result: results.get(runId) ?? null }))

  orca.panels.handle('android.agent.status', async () => {
    const { agents } = await orca.host.call('agents.list')
    return { count: agents.filter((agent) => agent.terminalId).length }
  })

  orca.panels.handle('android.agent.sendLog', async ({ text }: { text: string }) => {
    const { agents } = await orca.host.call('agents.list')
    const available = agents.filter((agent) => agent.terminalId)
    if (available.length !== 1) throw Object.assign(new Error(available.length ? 'Log sending requires exactly one agent terminal in the focused workspace' : 'No agent terminal is available in the focused workspace'), { code: 'agent_target_unavailable' })
    const result = await orca.host.call('terminal.sendText', { terminalId: available[0].terminalId!, text, enter: false })
    if (!result.accepted) throw Object.assign(new Error('Orca did not accept the log text'), { code: 'agent_send_failed' })
    return { accepted: true as const }
  })

  orca.commands.register('android-devtools.run', async (input: unknown) => {
    const args = (input && typeof input === 'object' ? input : {}) as { workspaceId?: string; profile?: string; options?: Partial<RunOptions> }
    const { workspaces } = await orca.host.call('workspace.list')
    const context = await orca.host.call('workspace.readContext')
    const workspace = workspaces.find((entry) => entry.id === args.workspaceId)
      ?? workspaces.find((entry) => entry.name === context?.displayName)
      ?? (workspaces.length === 1 ? workspaces[0] : undefined)
    if (!workspace) return 'Open a workspace in Orca and select it in Android Devtools before running.'
    const projectKey = `${workspace.path}\u0000${args.options?.module ?? ''}`
    const { value: project } = await projectCache.get(projectKey, () => discoverProject(workspace.path, args.options?.module))
    if (!project.supported) return project.reason ?? 'Unsupported Android project'
    const config = await readProjectConfig(project.root)
    const merged = resolveConfig(config, args.profile, args.options ?? {})
    const devices = await discoverDevices(project.root)
    const resolved = completeRunOptions(project, devices, merged)
    const runId = `command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await executeRun(project.root, runId, resolved, undefined, ({ stage, message }) => {
      log(orca, `${runId} ${stage}: ${message}`)
    })
    return JSON.stringify(result)
  })
}
