export type ExtraType = 'string' | 'boolean' | 'int' | 'long' | 'float' | 'double'

export interface IntentExtra {
  key: string
  type: ExtraType
  value: string | number | boolean
}

export interface RunOptions {
  module: string
  variant: string
  device: string
  build: boolean
  install: boolean
  clearData: boolean
  activity?: string
  uri?: string
  launchFlags?: string
  extras: IntentExtra[]
  timeoutMs: number
}

export interface AndroidDevice {
  serial: string
  model: string
  state: string
}

export interface AndroidProject {
  root: string
  rootProjectName?: string
  module: string
  modules: string[]
  variants: string[]
  applicationId?: string
  gradleWrapper: string
  androidCli: boolean
  supported: boolean
  reason?: string
}

export interface RunResult {
  status: 'success' | 'failed' | 'cancelled'
  exitCode: number | null
  durationMs: number
  logs: string[]
  buildLogs?: string[]
  runLogs?: string[]
  packageName?: string
  error?: { code: string; message: string }
}

export interface Profile {
  module?: string
  variant?: string
  device?: string
  build?: boolean
  install?: boolean
  clearData?: boolean
  activity?: string
  uri?: string
  launchFlags?: string
  extras?: IntentExtra[]
  debug_premium_ads?: boolean
  timeoutMs?: number
}

export interface ProjectConfig {
  version: 1
  profile?: string
  profiles?: Record<string, Profile>
  overrides?: Profile
}

export const DEFAULT_OPTIONS: Omit<RunOptions, 'module' | 'variant' | 'device'> = {
  build: true,
  install: true,
  clearData: false,
  extras: [],
  timeoutMs: 180_000
}

export function resolveConfig(config: ProjectConfig, profileName?: string, ui: Partial<RunOptions> = {}): Partial<RunOptions> {
  const selected = profileName ?? config.profile
  const profile = selected ? config.profiles?.[selected] : undefined
  const uiValues = Object.fromEntries(Object.entries(ui).filter(([, value]) => value !== undefined))
  const merged = { ...profile, ...config.overrides, ...uiValues }
  const { debug_premium_ads: premiumOption, ...options } = merged
  const extras = [...(options.extras ?? [])]
  if (premiumOption !== undefined) {
    const premiumExtra = { key: 'debug_premium_ads', type: 'boolean' as const, value: premiumOption }
    const existing = extras.findIndex((extra) => extra.key === premiumExtra.key)
    if (existing < 0) extras.push(premiumExtra)
    else extras[existing] = premiumExtra
  }
  return {
    ...options,
    ...(merged.extras || premiumOption !== undefined ? { extras } : undefined)
  }
}

export function completeRunOptions(project: AndroidProject, devices: AndroidDevice[], config: Partial<RunOptions>): RunOptions {
  const module = config.module || project.module
  const variant = config.variant || project.variants.find((value) => value.toLowerCase() === 'debug') || project.variants[0] || ''
  const device = config.device || (devices.length === 1 ? devices[0].serial : '')
  if (!project.modules.includes(module)) throw Object.assign(new Error(`Unknown Android module: ${module}`), { code: 'module_not_found' })
  if (!project.variants.includes(variant)) throw Object.assign(new Error(`Unknown build variant for ${module}: ${variant}`), { code: 'variant_not_found' })
  if (config.launchFlags !== undefined && !/^(?:0[xX][0-9a-fA-F]{1,8}|-?\d{1,10})$/.test(config.launchFlags)) throw Object.assign(new Error('Launch flags must be a decimal or 32-bit hex value'), { code: 'invalid_launch_flags' })
  const options = { ...DEFAULT_OPTIONS, ...config, module, variant, device } as RunOptions
  if (options.uri !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(options.uri)) throw Object.assign(new Error('uri must include a valid scheme'), { code: 'invalid_uri' })
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 900_000) {
    throw Object.assign(new Error('timeoutMs must be between 1000 and 900000'), { code: 'invalid_timeout' })
  }
  for (const extra of options.extras) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,254}$/.test(extra.key)) throw Object.assign(new Error(`Invalid Intent extra key: ${extra.key}`), { code: 'invalid_extra' })
    if (extra.type === 'string' && typeof extra.value !== 'string') throw Object.assign(new Error(`Extra ${extra.key} must be a string`), { code: 'invalid_extra' })
    if (extra.type === 'boolean' && typeof extra.value !== 'boolean') throw Object.assign(new Error(`Extra ${extra.key} must be a boolean`), { code: 'invalid_extra' })
    if (extra.type === 'int' && (typeof extra.value !== 'number' || !Number.isInteger(extra.value) || extra.value < -2_147_483_648 || extra.value > 2_147_483_647)) {
      throw Object.assign(new Error(`Extra ${extra.key} must be a 32-bit integer`), { code: 'invalid_extra' })
    }
    if (extra.type === 'long' && (typeof extra.value !== 'string' || !/^-?\d+$/.test(extra.value) || BigInt(extra.value) < -(2n ** 63n) || BigInt(extra.value) > 2n ** 63n - 1n)) {
      throw Object.assign(new Error(`Extra ${extra.key} must be a signed 64-bit integer string`), { code: 'invalid_extra' })
    }
    if ((extra.type === 'float' || extra.type === 'double') && (typeof extra.value !== 'number' || !Number.isFinite(extra.value))) {
      throw Object.assign(new Error(`Extra ${extra.key} must be a finite number`), { code: 'invalid_extra' })
    }
    if (extra.type === 'float' && Math.abs(extra.value as number) > 3.4028235e38) throw Object.assign(new Error(`Extra ${extra.key} is outside the float range`), { code: 'invalid_extra' })
  }
  return options
}
