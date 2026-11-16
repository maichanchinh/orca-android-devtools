#!/usr/bin/env node
import { resolve } from 'node:path'
import { discoverDevices, discoverProject } from './android/discovery.ts'
import { deleteProfile, readProjectConfig, saveProfile } from './android/config.ts'
import { executeRun } from './android/runner.ts'
import { completeRunOptions, resolveConfig } from './android/model.ts'
import type { IntentExtra, RunOptions } from './android/model.ts'

interface Args { command: string; action?: string; values: Map<string, string[]>; flags: Set<string> }

function parseArgs(argv: string[]): Args {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'run'
  let action: string | undefined
  if (command === 'profile' && argv[1] && !argv[1].startsWith('-')) action = argv[1]
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let index = (command === argv[0] ? (action ? 2 : 1) : 0); index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const [rawKey, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) values.set(rawKey, [...values.get(rawKey) ?? [], inline])
    else if (['build', 'install', 'clear-data', 'no-build', 'no-install', 'help'].includes(rawKey)) flags.add(rawKey)
    else {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${rawKey}`)
      values.set(rawKey, [...values.get(rawKey) ?? [], value])
    }
  }
  return { command, action, values, flags }
}

function get(args: Args, name: string): string | undefined { return args.values.get(name)?.at(-1) }

function parseExtra(raw: string): IntentExtra {
  const separator = raw.indexOf('=')
  const colon = raw.indexOf(':')
  if (colon < 1 || separator < colon + 2) throw new Error(`Extra must use key:type=value: ${raw}`)
  const key = raw.slice(0, colon)
  const type = raw.slice(colon + 1, separator) as IntentExtra['type']
  const value = raw.slice(separator + 1)
  if (!key.trim() || !['string', 'boolean', 'int', 'long', 'float', 'double'].includes(type)) throw new Error(`Invalid Intent extra: ${raw}`)
  if (type === 'string') return { key, type, value }
  if (type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error(`Boolean extra ${key} must be true or false`)
    return { key, type, value: value === 'true' }
  }
  if (type === 'long') {
    if (!/^-?\d+$/.test(value)) throw new Error(`Invalid numeric extra: ${key}`)
    try {
      const number = BigInt(value)
      if (number < -(2n ** 63n) || number > 2n ** 63n - 1n) throw new Error('out of range')
      return { key, type, value: number.toString() }
    } catch { throw new Error(`Invalid numeric extra: ${key}`) }
  }
  if (!value.trim()) throw new Error(`Numeric extra ${key} is required`)
  const number = Number(value)
  if (!Number.isFinite(number) || (['int', 'long'].includes(type) && !Number.isInteger(number))) throw new Error(`Invalid numeric extra: ${key}`)
  if (type === 'int' && (number < -2_147_483_648 || number > 2_147_483_647)) throw new Error(`int extra ${key} is out of range`)
  return { key, type, value: number }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.has('help') || args.command === 'help') {
    process.stdout.write('Usage: node src/cli.ts [run|discover] [--project PATH] [--profile NAME] [--module :app] [--variant debug] [--device SERIAL] [--uri URI] [--no-build] [--no-install] [--clear-data] [--activity CLASS] [--launch-flags 0x10000000] [--extra key:type=value]\n       node src/cli.ts profile [list|save|delete] --project PATH [--name NAME] [profile options]\n')
    return
  }
  const root = resolve(get(args, 'project') ?? process.cwd())
  if (args.command === 'profile') {
    const operation = args.action ?? 'list'
    const name = get(args, 'name')
    if (operation === 'list') {
      const config = await readProjectConfig(root)
      process.stdout.write(`${JSON.stringify({ profile: config.profile ?? null, profiles: config.profiles ?? {} }, null, 2)}\n`)
      return
    }
    if (operation === 'delete') {
      if (!name) throw new Error('profile delete requires --name NAME')
      const deleted = await deleteProfile(root, name)
      process.stdout.write(`${JSON.stringify({ deleted, name })}\n`)
      return
    }
    if (operation === 'save') {
      if (!name) throw new Error('profile save requires --name NAME')
      const profile: Partial<RunOptions> = {
        module: get(args, 'module'), variant: get(args, 'variant'), device: get(args, 'device'),
        build: args.flags.has('build') ? true : args.flags.has('no-build') ? false : undefined,
        install: args.flags.has('install') ? true : args.flags.has('no-install') ? false : undefined,
        clearData: args.flags.has('clear-data') ? true : undefined,
        activity: get(args, 'activity'), uri: get(args, 'uri'), launchFlags: get(args, 'launch-flags'),
        extras: args.values.get('extra')?.map(parseExtra),
        timeoutMs: get(args, 'timeout') ? Number(get(args, 'timeout')) : undefined
      }
      await saveProfile(root, name, profile)
      process.stdout.write(`${JSON.stringify({ saved: true, name })}\n`)
      return
    }
    throw new Error(`Unknown profile action: ${operation}`)
  }
  const project = await discoverProject(root, get(args, 'module'))
  if (args.command === 'discover') {
    const [devices, config] = await Promise.all([discoverDevices(project.root), readProjectConfig(project.root)])
    process.stdout.write(`${JSON.stringify({ project, devices, config }, null, 2)}\n`)
    return
  }
  if (!project.supported) throw Object.assign(new Error(project.reason ?? 'Unsupported Android project'), { code: 'unsupported_project' })
  const config = await readProjectConfig(project.root)
  const ui: Partial<RunOptions> = {
    module: get(args, 'module'), variant: get(args, 'variant'), device: get(args, 'device'),
    build: args.flags.has('build') ? true : args.flags.has('no-build') ? false : undefined,
    install: args.flags.has('install') ? true : args.flags.has('no-install') ? false : undefined,
    clearData: args.flags.has('clear-data') ? true : undefined,
    activity: get(args, 'activity'), uri: get(args, 'uri'), launchFlags: get(args, 'launch-flags'),
    extras: args.values.get('extra')?.map(parseExtra),
    timeoutMs: get(args, 'timeout') ? Number(get(args, 'timeout')) : undefined
  }
  const merged = resolveConfig(config, get(args, 'profile'), ui)
  const devices = await discoverDevices(project.root)
  const selectedDevice = merged.device || (devices.length === 1 ? devices[0].serial : '')
  const options = completeRunOptions(project, devices, { ...merged, device: selectedDevice })
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  const result = await executeRun(project.root, `cli-${Date.now()}`, options, controller.signal, ({ stage, message }) => {
    process.stderr.write(`[${stage}] ${message}\n`)
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status !== 'success') process.exitCode = result.status === 'cancelled' ? 130 : 1
}

void main().catch((error: Error & { code?: string }) => {
  process.stderr.write(`${JSON.stringify({ status: 'failed', exitCode: 1, error: { code: error.code ?? 'cli_error', message: error.message } })}\n`)
  process.exitCode = 1
})
