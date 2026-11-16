import { test } from 'orca/testing'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILE, deleteProfile, readProjectConfig, saveProfile } from './config.ts'

test('missing config is valid and profile save, edit and delete preserve config defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-devtools-config-'))
  try {
    const missing = await readProjectConfig(root)
    if (missing.version !== 1 || missing.profiles) throw new Error('missing YAML did not return default config')

    const extras = [
      { key: 'text', type: 'string' as const, value: 'hello world!' },
      { key: 'enabled', type: 'boolean' as const, value: true },
      { key: 'ratio', type: 'float' as const, value: 3.14159 },
      { key: 'year', type: 'int' as const, value: 2015 },
      { key: 'counter', type: 'long' as const, value: '9223372036854775807' }
    ]
    await saveProfile(root, 'smoke', { module: ':app', variant: 'Debug', build: false, uri: 'blurface://premium?source=debug', extras })
    let config = await readProjectConfig(root)
    if (config.profile !== 'smoke' || config.profiles?.smoke?.variant !== 'Debug' || config.profiles.smoke.build !== false || config.profiles.smoke.uri !== 'blurface://premium?source=debug' || JSON.stringify(config.profiles.smoke.extras) !== JSON.stringify(extras)) {
      throw new Error('profile was not written correctly')
    }
    await saveProfile(root, 'smoke', { module: ':app', variant: 'Release', install: false })
    config = await readProjectConfig(root)
    if (config.profiles?.smoke?.variant !== 'Release' || config.profiles.smoke.install !== false) throw new Error('profile edit did not replace values')
    if (!(await deleteProfile(root, 'smoke'))) throw new Error('existing profile was not deleted')
    config = await readProjectConfig(root)
    if (config.profile || config.profiles) throw new Error('deleted profile remains selected or configured')
    const source = await readFile(join(root, CONFIG_FILE), 'utf8')
    if (!source.includes('"version": 1')) throw new Error('YAML config was not preserved after deleting the final profile')
    if (await deleteProfile(root, 'smoke')) throw new Error('delete should report a missing profile')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
