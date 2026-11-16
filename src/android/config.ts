import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Profile, ProjectConfig } from './model.ts'

export const CONFIG_FILE = '.android-devtools.yaml'

export async function readProjectConfig(root: string): Promise<ProjectConfig> {
  try {
    const value = parseYaml(await readFile(join(root, CONFIG_FILE), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('YAML root must be a mapping')
    const config = value as unknown as ProjectConfig
    if (config.version !== 1) throw new Error('version must be 1')
    const allowed = new Set(['version', 'profile', 'profiles', 'overrides'])
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported config key: ${key}`)
    if (config.profile !== undefined && typeof config.profile !== 'string') throw new Error('profile must be a string')
    if (config.profiles !== undefined && (!config.profiles || typeof config.profiles !== 'object' || Array.isArray(config.profiles))) {
      throw new Error('profiles must be a mapping keyed by profile name')
    }
    validateProfile(config.overrides)
    for (const profile of Object.values(config.profiles ?? {})) validateProfile(profile)
    return config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }
    throw new Error(`Invalid ${CONFIG_FILE}: ${(error as Error).message}`)
  }
}

export async function saveProfile(root: string, name: string, profile: Profile): Promise<void> {
  await writeFile(join(root, CONFIG_FILE), await previewProfileYaml(root, name, profile), 'utf8')
}

export async function previewProfileYaml(root: string, name: string, profile: Profile): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(name)) throw new Error('Profile name must be 1–64 safe characters')
  validateProfile(profile)
  const config = await readProjectConfig(root)
  const defaults = { build: true, install: true, clearData: false, timeoutMs: 180_000 }
  const sparse = Object.fromEntries(Object.entries(profile).filter(([key, value]) => value !== defaults[key as keyof typeof defaults] && value !== undefined)) as Profile
  config.profiles = { ...config.profiles, [name]: sparse }
  config.profile = name
  return serializeYaml(config)
}

export async function deleteProfile(root: string, name: string): Promise<boolean> {
  const config = await readProjectConfig(root)
  if (!config.profiles?.[name]) return false
  const profiles = { ...config.profiles }
  delete profiles[name]
  const nextConfig = {
    ...config,
    profiles: Object.keys(profiles).length ? profiles : undefined,
    profile: config.profile === name ? undefined : config.profile
  }
  const persisted = Object.fromEntries(Object.entries(nextConfig).filter(([, value]) => value !== undefined))
  await writeFile(join(root, CONFIG_FILE), serializeYaml(persisted), 'utf8')
  return true
}

function validateProfile(profile: Profile | undefined): void {
  if (profile === undefined) return
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Profile must be a mapping')
  const allowed = new Set(['module', 'variant', 'device', 'build', 'install', 'clearData', 'activity', 'uri', 'launchFlags', 'extras', 'timeoutMs', 'debug_premium_ads'])
  for (const key of Object.keys(profile)) if (!allowed.has(key)) throw new Error(`Unsupported profile key: ${key}`)
  for (const key of ['build', 'install', 'clearData', 'debug_premium_ads'] as const) {
    if (profile[key] !== undefined && typeof profile[key] !== 'boolean') throw new Error(`${key} must be boolean`)
  }
  if (profile.extras !== undefined) {
    if (!Array.isArray(profile.extras)) throw new Error('extras must be a sequence')
    for (const extra of profile.extras) {
      if (!extra || typeof extra.key !== 'string' || !extra.key.trim() || !['string', 'boolean', 'int', 'long', 'float', 'double'].includes(extra.type)) {
        throw new Error('Each extra requires a key and supported scalar type')
      }
      if (extra.type === 'string' ? typeof extra.value !== 'string' : extra.type === 'boolean' ? typeof extra.value !== 'boolean' : extra.type === 'long' ? !(typeof extra.value === 'string' || typeof extra.value === 'number') : typeof extra.value !== 'number' || !Number.isFinite(extra.value)) {
        throw new Error(`Invalid value for extra ${extra.key}`)
      }
      if (extra.type === 'int' && (!Number.isInteger(extra.value) || (extra.value as number) < -2_147_483_648 || (extra.value as number) > 2_147_483_647)) throw new Error(`Extra ${extra.key} must be a 32-bit integer`)
      if (extra.type === 'long') {
        if (typeof extra.value !== 'string' || !/^-?\d+$/.test(extra.value)) throw new Error(`Extra ${extra.key} must use a quoted 64-bit integer`)
        const long = BigInt(extra.value)
        if (long < -(2n ** 63n) || long > 2n ** 63n - 1n) throw new Error(`Extra ${extra.key} is outside the signed 64-bit range`)
      }
      if (extra.type === 'float' && Math.abs(extra.value as number) > 3.4028235e38) throw new Error(`Extra ${extra.key} is outside the float range`)
    }
  }
  if (profile.timeoutMs !== undefined && (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 1000 || profile.timeoutMs > 900_000)) {
    throw new Error('timeoutMs must be between 1000 and 900000')
  }
  for (const key of ['module', 'variant', 'device', 'activity', 'uri', 'launchFlags'] as const) {
    if (profile[key] !== undefined && typeof profile[key] !== 'string') throw new Error(`${key} must be a string`)
  }
  if (profile.uri !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(profile.uri)) throw new Error('uri must include a valid scheme')
  if (profile.launchFlags !== undefined && !/^(?:0[xX][0-9a-fA-F]{1,8}|-?\d{1,10})$/.test(profile.launchFlags)) throw new Error('launchFlags must be a decimal or 32-bit hex value')
}

interface YamlLine { indent: number; text: string; line: number }
type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

function parseYaml(source: string): YamlValue {
  const lines: YamlLine[] = []
  for (const [index, raw] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (/\t/.test(raw.match(/^\s*/)?.[0] ?? '')) throw new Error(`Tabs are not allowed for indentation (line ${index + 1})`)
    const text = stripComment(raw).trimEnd()
    if (!text.trim() || text.trim() === '---' || text.trim() === '...') continue
    const indent = text.length - text.trimStart().length
    lines.push({ indent, text: text.trimStart(), line: index + 1 })
  }
  if (!lines.length) return {}
  const [value, next] = parseBlock(lines, 0, lines[0].indent)
  if (next !== lines.length) throw new Error(`Unexpected indentation at line ${lines[next].line}`)
  return value
}

function parseBlock(lines: YamlLine[], start: number, indent: number): [YamlValue, number] {
  if (lines[start]?.text === '[]') return [[], start + 1]
  if (lines[start]?.text === '{}') return [{}, start + 1]
  const sequence = lines[start]?.text === '-' || lines[start]?.text.startsWith('- ')
  const result: YamlValue[] | Record<string, YamlValue> = sequence ? [] : {}
  const push = (value: YamlValue) => (result as YamlValue[]).push(value)
  const setValue = (key: string, value: YamlValue) => { (result as Record<string, YamlValue>)[key] = value }
  let index = start
  while (index < lines.length && lines[index].indent === indent) {
    const line = lines[index]
    if (sequence) {
      if (!(line.text === '-' || line.text.startsWith('- '))) throw new Error(`Mixed YAML mapping and sequence (line ${line.line})`)
      const rest = line.text.slice(1).trimStart()
      index++
      if (!rest) {
        if (index >= lines.length || lines[index].indent <= indent) push(null)
        else {
          const [child, next] = parseBlock(lines, index, lines[index].indent)
          push(child)
          index = next
        }
      } else if (findColon(rest) >= 0) {
        const item: Record<string, YamlValue> = {}
        const [key, rawValue] = splitPair(rest, line.line)
        if (rawValue) item[key] = parseScalar(rawValue, line.line)
        else if (index < lines.length && lines[index].indent > indent + 1) {
          const [child, next] = parseBlock(lines, index, lines[index].indent)
          item[key] = child
          index = next
        } else item[key] = null
        if (index < lines.length && lines[index].indent > indent) {
          const [more, next] = parseBlock(lines, index, lines[index].indent)
          if (!more || typeof more !== 'object' || Array.isArray(more)) throw new Error(`Expected mapping fields after sequence item (line ${lines[index].line})`)
          Object.assign(item, more)
          index = next
        }
        push(item)
      } else {
        push(parseScalar(rest, line.line))
        if (index < lines.length && lines[index].indent > indent) throw new Error(`Scalar sequence item cannot have nested fields (line ${lines[index].line})`)
      }
    } else {
      if (line.text === '-' || line.text.startsWith('- ')) throw new Error(`Mixed YAML mapping and sequence (line ${line.line})`)
      const [key, rawValue] = splitPair(line.text, line.line)
      index++
      if (Object.hasOwn(result, key)) throw new Error(`Duplicate key '${key}' (line ${line.line})`)
      if (rawValue) setValue(key, parseScalar(rawValue, line.line))
      else if (index < lines.length && lines[index].indent > indent) {
        const [child, next] = parseBlock(lines, index, lines[index].indent)
        setValue(key, child)
        index = next
      } else setValue(key, null)
    }
    if (index < lines.length && lines[index].indent < indent) break
    if (index < lines.length && lines[index].indent > indent) throw new Error(`Unexpected indentation (line ${lines[index].line})`)
  }
  return [result, index]
}

function splitPair(text: string, line: number): [string, string] {
  const colon = findColon(text)
  if (colon < 1) throw new Error(`Expected key: value (line ${line})`)
  const key = parseKey(text.slice(0, colon).trim(), line)
  if (!key) throw new Error(`Empty key (line ${line})`)
  return [key, text.slice(colon + 1).trim()]
}

function parseKey(value: string, line: number): string {
  if (value.startsWith('"')) {
    try { const key: unknown = JSON.parse(value); if (typeof key === 'string') return key } catch { /* reported below */ }
    throw new Error(`Invalid quoted key (line ${line})`)
  }
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

function parseScalar(value: string, line: number): YamlValue {
  if (value.startsWith('"')) {
    try { return JSON.parse(value) as string } catch { throw new Error(`Invalid quoted string (line ${line})`) }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error(`Unterminated quoted string (line ${line})`)
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('{') || value.startsWith('[')) {
    try { return JSON.parse(value) as YamlValue } catch { throw new Error(`Inline collections must use JSON syntax (line ${line})`) }
  }
  return value
}

function findColon(text: string): number {
  let quote = ''
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote === '"' && escaped) { escaped = false; continue }
    if (quote === '"' && char === '\\') { escaped = true; continue }
    if (quote && char === quote) { quote = ''; continue }
    if (!quote && (char === '"' || char === "'")) { quote = char; continue }
    if (!quote && char === ':' && (index + 1 === text.length || /\s/.test(text[index + 1]))) return index
  }
  return -1
}

function stripComment(line: string): string {
  let quote = ''
  let escaped = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote === '"' && escaped) { escaped = false; continue }
    if (quote === '"' && char === '\\') { escaped = true; continue }
    if (quote && char === quote) { quote = ''; continue }
    if (!quote && (char === '"' || char === "'")) { quote = char; continue }
    if (!quote && char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

function serializeYaml(value: unknown): string {
  return `${serializeNode(value, 0)}\n`
}

function serializeNode(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`
    return value.map((item) => {
      if (item !== null && typeof item === 'object') return `${pad}-\n${serializeNode(item, indent + 2)}`
      return `${pad}- ${serializeScalar(item)}`
    }).join('\n')
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return `${pad}{}`
    return entries.map(([key, item]) => {
      const prefix = `${pad}${JSON.stringify(key)}:`
      if (item !== null && typeof item === 'object') return `${prefix}\n${serializeNode(item, indent + 2)}`
      return `${prefix} ${serializeScalar(item)}`
    }).join('\n')
  }
  return `${pad}${serializeScalar(value)}`
}

function serializeScalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'null'
  throw new Error(`Unsupported YAML value: ${String(value)}`)
}
