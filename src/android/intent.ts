import type { IntentExtra } from './model.ts'

export function encodeIntentExtra(extra: IntentExtra): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,254}$/.test(extra.key)) throw Object.assign(new Error(`Invalid Intent extra key: ${extra.key}`), { code: 'invalid_extra' })
  const flag = ({ string: '--es', boolean: '--ez', int: '--ei', long: '--el', float: '--ef', double: '--ed' } as const)[extra.type]
  return [flag, extra.key, String(extra.value)]
}

export function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildRemoteShellCommand(args: string[]): string {
  return args.map(quoteShellArgument).join(' ')
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteShellArgument).join(' ')
}
