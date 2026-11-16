import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'

function findNode(node: any, predicate: (candidate: any) => boolean): any {
  if (predicate(node)) return node
  for (const child of node?.children ?? []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return undefined
}

test('Android panel renders an interactive device and variant runner', async () => {
  const runs: unknown[] = []
  const sentLogs: string[] = []
  const host = mockHost({
    requests: {
      'android.workspaces': () => ({ workspaces: [{ id: 'blur', kind: 'folder', name: 'BlurFaceCensorMosaic', path: '/workspace/blur', hostId: 'local' }], focusedId: 'blur', focusedName: 'BlurFaceCensorMosaic' }),
      'android.discover': () => ({ project: { root: '/workspace/blur', module: ':app', modules: [':app'], variants: ['Debug', 'Release'], applicationId: 'com.example.blur', gradleWrapper: '/workspace/blur/gradlew', androidCli: true, supported: true }, devices: [{ serial: 'device-1', model: 'Pixel 9', state: 'device' }], config: { version: 1, profile: 'premium-ads', profiles: { 'premium-ads': { uri: 'blurface://premium', extras: [{ key: 'data', type: 'string', value: 'premium' }, { key: 'debug_premium_ads', type: 'boolean', value: true }] } } } }),
      'android.run.start': (input) => { runs.push(input); return { runId: 'run-1' } },
      'android.agent.status': () => ({ count: 1 }),
      'android.agent.sendLog': (input) => { sentLogs.push((input as { text: string }).text); return { accepted: true } }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  await view.press({ label: 'Refresh project and devices' })
  await view.settled()
  assert.ok(view.summary().some((line) => line.includes('Android Run')), JSON.stringify(view.summary()))
  assert.equal(view.find({ label: 'Workspace' }), null)
  assert.ok(view.find({ label: 'Device' }))
  assert.equal(view.find({ label: 'Build before Run' }), null)
  assert.ok(view.find({ text: 'Debug' }))
  assert.ok(view.find({ text: 'Release' }))
  assert.equal(view.find({ text: 'Advanced Options' }), null)
  assert.equal(view.find({ label: 'Build log output' }), null)
  await view.press({ label: 'Open Profile manager' })
  assert.ok(view.summary().some((line) => line.includes('Profile manager')))
  assert.ok(view.find({ label: 'Profile name' }))
  await view.press({ label: 'Back to Android Run' })
  await view.press({ text: 'Release' })
  await view.select({ label: 'Device' }, 'device-1')
  await view.press({ text: 'Run' })
  assert.equal(runs.length, 1)
  assert.deepEqual((runs[0] as { options: { variant: string; device: string; uri: string; build: boolean; extras: unknown[] } }).options, { module: ':app', variant: 'Release', device: 'device-1', build: true, install: true, clearData: false, uri: 'blurface://premium', extras: [{ key: 'data', type: 'string', value: 'premium' }, { key: 'debug_premium_ads', type: 'boolean', value: true }] })
  await view.post('android.run.changed', { runId: 'run-1', status: 'success', result: { status: 'success', durationMs: 10, exitCode: 0, logs: [] } })
  await view.press({ text: 'Debug' })
  await view.press({ text: 'Run' })
  assert.equal((runs[1] as { options: { variant: string } }).options.variant, 'Debug')
  await view.post('android.run.changed', { runId: 'run-1', status: 'success', result: { status: 'success', durationMs: 10, exitCode: 0, logs: [] } })
  await view.press({ text: 'Release' })
  await view.press({ text: 'Run' })
  assert.equal((runs[2] as { options: { variant: string } }).options.variant, 'Release')
  await view.post('android.run.progress', { runId: 'run-1', stage: 'build', message: '> Task :app:assembleDebug' })
  await view.settled()
  await view.press({ text: 'Show logs' })
  assert.ok(JSON.stringify(view.tree()).includes('build: > Task :app:assembleDebug'))
  assert.ok(view.find({ label: 'Build log output' }))
  assert.ok(view.find({ text: 'Clear log' }))
  await view.press({ text: 'Send to agent' })
  assert.equal(sentLogs.length, 1)
  assert.ok(sentLogs[0].includes('Android Devtools build log'))
  await view.press({ text: 'Clear log' })
  assert.ok(JSON.stringify(view.tree()).includes('No build output yet.'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('focused unsupported workspace stays visible, unavailable variants and Run remain disabled', async () => {
  const host = mockHost({ requests: {
    'android.workspaces': () => ({ workspaces: [{ id: 'unsupported', kind: 'folder', name: 'Docs', path: '/workspace/docs', hostId: 'local' }], focusedId: 'unsupported', focusedName: 'Docs' }),
    'android.discover': () => ({ project: { root: '/workspace/docs', module: '', modules: [], variants: [], gradleWrapper: '', androidCli: false, supported: false, reason: 'No Gradle Android project found' }, devices: [], config: { version: 1 } })
  } })
  const view = await mount(panel, { host })
  await view.settled()
  await view.press({ label: 'Refresh project and devices' })
  await view.settled()
  assert.ok(JSON.stringify(view.tree()).includes('No Gradle Android project found'))
  const releaseButton = findNode(view.tree(), (node) => node?.type === 'Button' && node.children?.includes('Release'))
  assert.equal(releaseButton?.props?.disabled, true)
  const runButton = findNode(view.tree(), (node) => node?.type === 'Button' && node.children?.includes('Run'))
  assert.equal(runButton?.props?.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('ADB devices remain visible without an active project and offline devices cannot run', async () => {
  const host = mockHost({ requests: {
    'android.workspaces': () => ({ workspaces: [], focusedId: null, focusedName: null }),
    'android.devices': () => ({ devices: [
      { serial: 'online-1', model: 'Pixel 9', state: 'device' },
      { serial: 'offline-1', model: 'Pixel 8', state: 'offline' },
      { serial: 'unauthorized-1', model: 'Pixel 7', state: 'unauthorized' }
    ] })
  } })
  const view = await mount(panel, { host })
  await view.settled()
  assert.ok(JSON.stringify(view.tree()).includes('Pixel 9'))
  assert.ok(JSON.stringify(view.tree()).includes('offline'))
  assert.ok(JSON.stringify(view.tree()).includes('unauthorized'))
  const runButton = findNode(view.tree(), (node) => node?.type === 'Button' && node.children?.includes('Run'))
  assert.equal(runButton?.props?.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('multiple app modules can be selected and run failure exposes actionable details', async () => {
  const runs: unknown[] = []
  const host = mockHost({ requests: {
    'android.workspaces': () => ({ workspaces: [{ id: 'multi', kind: 'folder', name: 'Multi', path: '/workspace/multi', hostId: 'local' }], focusedId: 'multi', focusedName: 'Multi' }),
    'android.discover': (input) => {
      const module = (input as { module?: string }).module ?? ':app'
      return { project: { root: '/workspace/multi', module, modules: [':app', ':demo'], variants: ['Debug'], applicationId: 'com.example.multi', gradleWrapper: '/workspace/multi/gradlew', androidCli: true, supported: true }, devices: [{ serial: 'online', model: 'Pixel 9', state: 'device' }], config: { version: 1 } }
    },
    'android.run.start': (input) => { runs.push(input); return { runId: 'failed-run' } }
  } })
  const view = await mount(panel, { host })
  await view.settled()
  await view.select({ label: 'App module' }, ':demo')
  await view.settled()
  await view.press({ text: 'Run' })
  assert.equal((runs[0] as { options: { module: string } }).options.module, ':demo')
  await view.post('android.run.changed', { runId: 'failed-run', status: 'failed', result: { status: 'failed', durationMs: 50, exitCode: 1, logs: [], error: { code: 'gradle_failed', message: 'Gradle assembleDebug failed (exit 1)' } } })
  assert.ok(JSON.stringify(view.tree()).includes('Gradle assembleDebug failed (exit 1)'))
  assert.ok(view.find({ text: 'Copy error' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('project selections restore independently when focus switches A to B to A', async () => {
  const workspaces = [
    { id: 'a', kind: 'folder' as const, name: 'Project A', path: '/workspace/a', hostId: 'local' },
    { id: 'b', kind: 'folder' as const, name: 'Project B', path: '/workspace/b', hostId: 'local' }
  ]
  let focusedId = 'a'
  const host = mockHost({ requests: {
    'android.workspaces': () => ({ workspaces, focusedId, focusedName: focusedId === 'a' ? 'Project A' : 'Project B' }),
    'android.discover': (input) => {
      const root = (input as { root: string }).root
      const profile = root.endsWith('/a') ? 'alpha' : 'gamma'
      const otherProfile = root.endsWith('/a') ? 'beta' : 'delta'
      return {
        project: { root, module: ':app', modules: [':app'], variants: ['Debug', 'Release'], applicationId: 'com.example.app', gradleWrapper: `${root}/gradlew`, androidCli: true, supported: true },
        devices: [{ serial: `device-${root.endsWith('/a') ? 'a' : 'b'}`, model: 'Pixel', state: 'device' }],
        config: { version: 1, profile, profiles: { [profile]: { variant: 'Debug' }, [otherProfile]: { variant: 'Debug' } } }
      }
    }
  } })
  const view = await mount(panel, { host })
  await view.settled()
  await view.select({ label: 'Profile' }, 'beta')
  await view.press({ text: 'Release' })

  focusedId = 'b'
  await view.emit('workspace.changed', {} as never)
  await view.settled()
  assert.equal(view.valueOf({ label: 'Profile' }), 'gamma')

  focusedId = 'a'
  await view.emit('workspace.changed', {} as never)
  await view.settled()
  assert.equal(view.valueOf({ label: 'Profile' }), 'beta')
  const releaseButton = findNode(view.tree(), (node) => node?.type === 'Button' && node.children?.includes('Release'))
  assert.equal(releaseButton?.props?.variant, 'solid')
  assert.equal(JSON.stringify(view.tree()).includes('device-a'), true)
  assert.deepEqual(view.errors, [])
  const persisted = view.persisted.plugin
  await view.unmount()
  const reopened = await mount(panel, { host, persisted: { plugin: persisted } })
  await reopened.settled()
  assert.equal(reopened.valueOf({ label: 'Profile' }), 'beta')
  const reopenedRelease = findNode(reopened.tree(), (node) => node?.type === 'Button' && node.children?.includes('Release'))
  assert.equal(reopenedRelease?.props?.variant, 'solid')
  await reopened.unmount()
})

test('late discovery response from the previous workspace cannot replace the focused project', async () => {
  const workspaces = [
    { id: 'a', kind: 'folder' as const, name: 'Project A', path: '/workspace/a', hostId: 'local' },
    { id: 'b', kind: 'folder' as const, name: 'Project B', path: '/workspace/b', hostId: 'local' }
  ]
  let focusedId = 'a'
  let releaseA!: (value: unknown) => void
  let aSlowStarted!: () => void
  const slowAStarted = new Promise<void>((resolve) => { aSlowStarted = resolve })
  let callsA = 0
  let arriveB!: () => void
  const bArrived = new Promise<void>((resolve) => { arriveB = resolve })
  const project = (root: string) => ({
    project: { root, module: ':app', modules: [':app'], variants: ['Debug', 'Release'], applicationId: root.endsWith('/a') ? 'com.example.a' : 'com.example.b', gradleWrapper: `${root}/gradlew`, androidCli: false, supported: true },
    devices: [], config: { version: 1 }
  })
  const host = mockHost({ requests: {
    'android.workspaces': () => ({ workspaces, focusedId, focusedName: focusedId === 'a' ? 'Project A' : 'Project B' }),
    'android.discover': (input) => {
      const root = (input as { root: string }).root
      if (root.endsWith('/a')) {
        callsA += 1
        if (callsA === 1) return project(root)
        return new Promise((resolve) => { releaseA = resolve; aSlowStarted() })
      }
      arriveB()
      return project(root)
    }
  } })
  const view = await mount(panel, { host })
  await view.settled()
  void view.emit('workspace.changed', {} as never)
  await slowAStarted
  focusedId = 'b'
  void view.emit('workspace.changed', {} as never)
  await bArrived
  releaseA(project('/workspace/a'))
  await view.settled()
  assert.ok(JSON.stringify(view.tree()).includes('com.example.b'))
  assert.equal(JSON.stringify(view.tree()).includes('com.example.a'), false)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
