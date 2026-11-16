import type { AndroidDevice, AndroidProject, Profile, ProjectConfig, RunOptions, RunResult } from './android/model.ts'

export interface OrcaWorkspace {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  hostId?: string | null
}

declare module 'orca' {
  interface PluginRequests {
    'android.workspaces': { output: { workspaces: OrcaWorkspace[]; focusedId: string | null; focusedName: string | null } }
    'android.discover': { input: { root: string; module?: string; refresh?: boolean }; output: { project: AndroidProject; devices: AndroidDevice[]; config: ProjectConfig } }
    'android.profile.save': { input: { root: string; name: string; profile: Profile }; output: { ok: true } }
    'android.profile.delete': { input: { root: string; name: string }; output: { ok: true; deleted: boolean } }
    'android.run.start': { input: { root: string; profile?: string; options: Partial<RunOptions> }; output: { runId: string } }
    'android.run.cancel': { input: { runId: string }; output: { cancelled: boolean } }
    'android.run.result': { input: { runId: string }; output: { result: RunResult | null } }
    'android.agent.status': { output: { count: number } }
    'android.agent.sendLog': { input: { text: string }; output: { accepted: true } }
  }
  interface PluginPanelEvents {
    'android.run.changed': { runId: string; status: string; result?: RunResult }
    'android.run.progress': { runId: string; stage: 'build' | 'install' | 'launch' | 'status' | 'error'; message: string }
    'android.log': { message: string; at: number }
  }
}
