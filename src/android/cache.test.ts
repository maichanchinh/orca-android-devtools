import { assert, test } from 'orca/testing'
import { PersistentCache } from './cache.ts'

function memoryStorage() {
  const values = new Map<string, unknown>()
  return {
    values,
    async get(key: string) { return values.get(key) ?? null },
    async set(key: string, value: unknown) { values.set(key, value) },
    async delete(key: string) { values.delete(key) }
  }
}

const decode = (value: unknown): { root: string; module: string } | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { root?: unknown; module?: unknown }
  return typeof candidate.root === 'string' && typeof candidate.module === 'string'
    ? { root: candidate.root, module: candidate.module }
    : undefined
}

test('persistent project cache restores across worker instances and refreshes only one project module', async () => {
  const storage = memoryStorage()
  const first = new PersistentCache(storage, 'projects', decode)
  const calls: string[] = []
  const load = (root: string, module: string) => async () => {
    calls.push(`${root}:${module}`)
    return { root, module }
  }

  await first.get('/a', load('/a', ':app'))
  await first.get('/b', load('/b', ':app'))

  const afterRestart = new PersistentCache(storage, 'projects', decode)
  assert.deepEqual(await afterRestart.get('/a', load('/a', ':app')), { value: { root: '/a', module: ':app' }, source: 'storage' })
  await afterRestart.get('/a\u0000:tools', load('/a', ':tools'))
  await afterRestart.get('/a', load('/a', ':app'), true)
  assert.deepEqual(calls, ['/a::app', '/b::app', '/a::tools', '/a::app'])
  assert.deepEqual(await new PersistentCache(storage, 'projects', decode).get('/b', load('/b', ':app')), { value: { root: '/b', module: ':app' }, source: 'storage' })
})

test('persistent cache does not allow an invalidated in-flight discovery to overwrite fresh storage', async () => {
  const storage = memoryStorage()
  const cache = new PersistentCache(storage, 'projects', decode)
  let release!: (value: { root: string; module: string }) => void
  const oldLoad = cache.get('/a', () => new Promise((resolve) => { release = resolve }))
  await cache.invalidate('/a')
  const fresh = await cache.get('/a', async () => ({ root: '/a', module: ':fresh' }))
  release({ root: '/a', module: ':stale' })
  await oldLoad
  assert.deepEqual(fresh.value, { root: '/a', module: ':fresh' })
  assert.deepEqual(await new PersistentCache(storage, 'projects', decode).get('/a', async () => ({ root: '/a', module: ':reload' })), { value: { root: '/a', module: ':fresh' }, source: 'storage' })
})
