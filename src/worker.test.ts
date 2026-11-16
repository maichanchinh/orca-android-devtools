import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'
import { jsonSafe } from './worker'

test('worker response serialization omits undefined optional project fields', () => {
  const safe = jsonSafe({ project: { supported: true, applicationId: 'com.example.app', reason: undefined } })
  assert.deepEqual(safe, { project: { supported: true, applicationId: 'com.example.app' } })
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), safe)
})

test('android discovery returns strict JSON for an unsupported empty workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-devtools-discovery-'))
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    const response = await worker.request('android.discover', { root })
    assert.deepEqual(JSON.parse(JSON.stringify(response)), response)
    assert.equal(response.project.supported, false)
    assert.equal(response.project.reason, 'No Gradle Android project found')
    assert.equal(worker.logs.some((line) => line.includes('discover ')), true)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})

test('project metadata survives worker restart while YAML stays fresh until scoped Refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-devtools-persisted-discovery-'))
  const host = mockHost({ capabilities: ['workspace:read', 'agent:read', 'terminal:send', 'storage:own'] })
  let worker = await mountWorker(main, { host })
  try {
    await worker.request('android.discover', { root })
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    const cached = await worker.request('android.discover', { root })
    assert.equal(worker.logs.some((line) => line.includes('cache project=storage')), true)
    assert.equal(cached.project.supported, false)

    await worker.request('android.profile.save', { root, name: 'qa', profile: { variant: 'Debug' } })
    const rereadYaml = await worker.request('android.discover', { root })
    assert.equal(rereadYaml.config.profiles?.qa?.variant, 'Debug')
    assert.equal(worker.logs.some((line) => line.includes('cache project=memory')), true)

    await worker.request('android.discover', { root, refresh: true })
    assert.equal(worker.logs.some((line) => line.includes('cache project=loaded') && line.includes('refreshed')), true)
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})

test('worker profile requests create and remove YAML profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-devtools-profile-'))
  const worker = await mountWorker(main, { host: mockHost() })
  try {
    assert.deepEqual(await worker.request('android.profile.save', { root, name: 'qa', profile: { variant: 'Debug', build: false } }), { ok: true })
    assert.deepEqual(await worker.request('android.profile.delete', { root, name: 'qa' }), { ok: true, deleted: true })
    assert.deepEqual(await worker.request('android.profile.delete', { root, name: 'qa' }), { ok: true, deleted: false })
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})

test('worker sends log into the sole agent terminal without submitting it', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read', 'terminal:send', 'storage:own'],
    results: {
      'agents.list': { agents: [{ terminalId: 'agent-terminal', title: 'Agent', agent: 'codex', state: 'working', stateStartedAt: 1 }] },
      'terminal.sendText': { accepted: true }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    assert.deepEqual(await worker.request('android.agent.status'), { count: 1 })
    assert.deepEqual(await worker.request('android.agent.sendLog', { text: 'Build log' }), { accepted: true })
    assert.deepEqual(host.callsOf('terminal.sendText'), [{ terminalId: 'agent-terminal', text: 'Build log', enter: false }])
    assert.deepEqual(worker.refusals, [])
  } finally { await worker.deactivate() }
})

test('worker refuses to send a log when multiple agent terminals are present', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'agent:read', 'terminal:send', 'storage:own'],
    results: { 'agents.list': { agents: [
      { terminalId: 'agent-1', title: 'Agent 1', agent: 'codex', state: 'working', stateStartedAt: 1 },
      { terminalId: 'agent-2', title: 'Agent 2', agent: 'claude', state: 'waiting', stateStartedAt: 2 }
    ] } }
  })
  const worker = await mountWorker(main, { host })
  try {
    let error: Error & { code?: string } | undefined
    try { await worker.request('android.agent.sendLog', { text: 'Build log' }) } catch (issue) { error = issue as Error & { code?: string } }
    assert.equal(error?.code, 'agent_target_unavailable')
    assert.equal(host.callsOf('terminal.sendText').length, 0)
    assert.deepEqual(worker.refusals, [])
  } finally { await worker.deactivate() }
})
