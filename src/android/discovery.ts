import { access, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { runCommand, runGradle } from './process.ts'
import type { AndroidDevice, AndroidProject } from './model.ts'

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

export async function findProjectRoot(start: string): Promise<string | null> {
  let current = resolve(start)
  while (true) {
    if (await exists(join(current, 'settings.gradle')) || await exists(join(current, 'settings.gradle.kts'))) return current
    const parent = resolve(current, '..')
    if (parent === current) return null
    current = parent
  }
}

export async function discoverProject(start: string, requestedModule?: string): Promise<AndroidProject> {
  const root = await findProjectRoot(start)
  if (!root) return { root: resolve(start), module: '', modules: [], variants: [], gradleWrapper: '', androidCli: false, supported: false, reason: 'No Gradle Android project found' }
  const rootProjectName = await readRootProjectName(root)
  const gradleWrapper = process.platform === 'win32' ? join(root, 'gradlew.bat') : join(root, 'gradlew')
  if (!(await exists(gradleWrapper))) return { root, ...(rootProjectName ? { rootProjectName } : {}), module: '', modules: [], variants: [], gradleWrapper: '', androidCli: false, supported: false, reason: 'Gradle wrapper not found' }

  const modules = await discoverModules(root)
  const androidModules = modules.filter((module) => moduleHasAndroidMarkers(root, module))
  const module = requestedModule ?? (androidModules.includes(':app') ? ':app' : androidModules.length === 1 ? androidModules[0] : '')
  if (!module || !androidModules.includes(module)) {
    return { root, ...(rootProjectName ? { rootProjectName } : {}), module, modules: androidModules, variants: [], gradleWrapper, androidCli: false, supported: false, reason: androidModules.length ? 'Select an Android application module' : 'No Android application module detected' }
  }

  const { variants, androidCli } = await discoverVariants(root, module)
  const applicationId = await discoverApplicationId(root, module)
  return { root, ...(rootProjectName ? { rootProjectName } : {}), module, modules: androidModules, variants, ...(applicationId ? { applicationId } : {}), gradleWrapper, androidCli, supported: variants.length > 0, ...(variants.length ? {} : { reason: 'Could not discover build variants' }) }
}

export async function readRootProjectName(root: string): Promise<string | undefined> {
  for (const filename of ['settings.gradle.kts', 'settings.gradle']) {
    try {
      const source = await readFile(join(root, filename), 'utf8')
      const match = source.match(/^\s*rootProject\.name\s*=\s*(["'])(.*?)\1\s*(?:\/\/.*)?$/m)
      if (match?.[2]?.trim()) return match[2].trim()
    } catch { /* Try the other settings file or fall back to the workspace name. */ }
  }
  return undefined
}

async function discoverApplicationId(root: string, module: string): Promise<string | undefined> {
  const moduleRoot = join(root, ...module.split(':').filter(Boolean))
  const gradleFiles = ['build.gradle.kts', 'build.gradle']
  for (const filename of gradleFiles) {
    try {
      const source = await readFile(join(moduleRoot, filename), 'utf8')
      const match = source.match(/\bapplicationId\s*(?:=\s*)?["']([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)["']/)
      if (match) return match[1]
    } catch { /* Try the manifest fallback. */ }
  }
  for (const filename of ['src/main/AndroidManifest.xml', 'src/main/manifest/AndroidManifest.xml']) {
    try {
      const manifest = await readFile(join(moduleRoot, filename), 'utf8')
      const match = manifest.match(/<manifest\b[^>]*\bpackage\s*=\s*["']([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)["']/)
      if (match) return match[1]
    } catch { /* Continue to the next supported manifest path. */ }
  }
  return undefined
}

async function findGradleModules(root: string): Promise<string[]> {
  const result = await runGradle(root, ['projects', '--console=plain'], undefined, 45_000)
  if (result.exitCode !== 0) return [':app', ...await findNestedModules(root)]
  const modules = [...result.stdout.matchAll(/Project '(:[^']+)'/g)].map((match) => match[1])
  return modules.length ? modules : [':']
}

async function discoverModules(root: string): Promise<string[]> {
  for (const file of ['settings.gradle.kts', 'settings.gradle']) {
    try {
      const source = await readFile(join(root, file), 'utf8')
      const modules = [...source.matchAll(/include\s*\(?([^\n)]*)\)?/g)]
        .flatMap((match) => [...match[1].matchAll(/["'](:[^"']+)["']/g)].map((item) => item[1]))
      const existing = []
      for (const module of new Set(modules)) if (await moduleHasAndroidMarkers(root, module)) existing.push(module)
      if (existing.length) return existing
    } catch { /* Gradle projects remains the fallback for generated settings. */ }
  }
  return findGradleModules(root)
}

async function findNestedModules(root: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 5) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || ['.gradle', 'build', '.git', 'node_modules'].includes(entry.name)) continue
      const path = join(dir, entry.name)
      const name = `${prefix}:${entry.name}`
      if (await exists(join(path, 'build.gradle')) || await exists(join(path, 'build.gradle.kts'))) output.push(name)
      await visit(path, name, depth + 1)
    }
  }
  await visit(root, '', 0)
  return output
}

async function moduleHasAndroidMarkers(root: string, module: string): Promise<boolean> {
  const path = join(root, ...module.split(':').filter(Boolean))
  if (!(await exists(join(path, 'build.gradle'))) && !(await exists(join(path, 'build.gradle.kts')))) return false
  return (await exists(join(path, 'src', 'main', 'AndroidManifest.xml'))) || (await exists(join(path, 'src', 'main', 'kotlin'))) || (await exists(join(path, 'src', 'main', 'java')))
}

async function discoverVariants(root: string, module: string): Promise<{ variants: string[]; androidCli: boolean }> {
  let androidVariants: string[] = []
  try {
    const described = await runCommand('android', ['describe', `--project_dir=${root}`], root, undefined, 20_000)
    if (described.exitCode === 0) {
      const output = `${described.stdout}\n${described.stderr}`
      const variants = installableVariants(collectVariants(output, module))
      if (variants.some((variant) => variant.toLowerCase().endsWith('release'))) return { variants, androidCli: true }
      androidVariants = variants
      for (const file of metadataFiles(output, root)) {
        try {
          const variants = installableVariants(collectVariants(await readFile(file, 'utf8'), module))
          if (variants.some((variant) => variant.toLowerCase().endsWith('release'))) return { variants, androidCli: true }
          androidVariants = [...new Set([...androidVariants, ...variants])]
        } catch { /* Gradle task discovery below remains the fallback. */ }
      }
    }
  } catch { /* Android CLI is optional; use Gradle below. */ }
  const result = await runGradle(root, [`${module}:tasks`, '--all', '--console=plain'], undefined, 60_000)
  if (result.exitCode !== 0) return { variants: androidVariants, androidCli: androidVariants.length > 0 }
  const tasks = `${result.stdout}\n${result.stderr}`
  const variants = collectGradleVariants(tasks)
  return { variants: [...new Set([...androidVariants, ...variants])].sort((a, b) => a.localeCompare(b)), androidCli: androidVariants.length > 0 }
}

export function collectGradleVariants(tasks: string): string[] {
  const variants = [...tasks.matchAll(/^assemble([A-Z][A-Za-z0-9]*)\s+-/gm)].map((match) => match[1])
  return installableVariants(variants)
}

function collectVariants(text: string, module: string): string[] {
  const values = new Set<string>()
  for (const match of text.matchAll(/"(?:variant|variantName)"\s*:\s*"([^"]+)"/g)) values.add(match[1])
  for (const match of text.matchAll(/"(?:target|targetName|buildTarget)"\s*:\s*"([^"]+)"/g)) {
    const target = match[1]
    const name = target.split('@').at(-1)
    if (name && (!target.includes(':') || target.includes(module))) values.add(name)
  }
  return [...values].sort((a, b) => a.localeCompare(b))
}

function installableVariants(variants: string[]): string[] {
  return [...new Set(variants.filter((variant) => variant && !/(?:AndroidTest|UnitTest|Test)$/i.test(variant)))].sort((a, b) => a.localeCompare(b))
}

function metadataFiles(output: string, root: string): string[] {
  const paths = new Set<string>()
  const addTree = (value: unknown): void => {
    if (typeof value === 'string' && value.toLowerCase().endsWith('.json')) paths.add(value)
    else if (Array.isArray(value)) value.forEach(addTree)
    else if (value && typeof value === 'object') Object.values(value).forEach(addTree)
  }
  try { addTree(JSON.parse(output) as unknown) } catch { /* The CLI may print one metadata path per line. */ }
  for (const match of output.matchAll(/(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^\r\n"'\s]+\.json/gi)) paths.add(match[0])
  return [...paths].map((path) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : join(root, path))
}

export async function discoverDevices(cwd: string): Promise<AndroidDevice[]> {
  const result = await runCommand('adb', ['devices', '-l'], cwd, undefined, 10_000)
  if (result.exitCode !== 0) return []
  return parseAdbDevices(result.stdout)
}

export function parseAdbDevices(output: string): AndroidDevice[] {
  return output.split(/\r?\n/).slice(1).flatMap((line) => {
    const fields = line.trim().match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/)
    if (!fields || !['device', 'offline', 'unauthorized'].includes(fields[2])) return []
    const model = fields[3]?.match(/(?:^|\s)model:(\S+)/)?.[1]
    return [{ serial: fields[1], state: fields[2], model: model?.replace(/_/g, ' ') ?? fields[1] }]
  })
}

export function findAndroidSdk(): string | undefined {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (env) return env
  const guesses = process.platform === 'win32'
    ? [join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')]
    : process.platform === 'darwin'
      ? [join(process.env.HOME ?? '', 'Library', 'Android', 'sdk')]
      : [join(process.env.HOME ?? '', 'Android', 'Sdk')]
  return guesses.find((path) => path && path !== '/')
}

export async function findApkCandidates(root: string, module: string, variant: string, deviceSerial?: string): Promise<string[]> {
  const output = join(root, ...module.split(':').filter(Boolean), 'build', 'outputs', 'apk')
  const apkDir = output
  const result: string[] = []
  const scan = async (path: string, depth: number): Promise<void> => {
    if (depth > 2) return
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = join(path, entry.name)
      if (entry.isFile() && entry.name.endsWith('.apk')) result.push(file)
      else if (entry.isDirectory()) await scan(file, depth + 1)
    }
  }
  await scan(apkDir, 0)
  const variantLower = variant.toLowerCase().replace(/[^a-z0-9]/g, '')
  const matching = result.filter((path) => {
    const pathFromOutput = relative(output, path)
    if (/(?:^|[\\/])(?:androidTest|testFixtures)(?:[\\/]|$)/i.test(pathFromOutput) || /androidTest/i.test(pathFromOutput)) return false
    return pathFromOutput.toLowerCase().replace(/[^a-z0-9]/g, '').includes(variantLower)
  })
  let candidates = matching
  if (!candidates.length && result.length === 1) {
    const metadataPath = join(result[0], '..', 'output-metadata.json')
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { variantName?: string }
      if (metadata.variantName?.toLowerCase() === variant.toLowerCase()) candidates = result
    } catch { /* Do not guess a variant when artifact metadata is unavailable. */ }
  }
  const universal = candidates.filter((path) => /universal/i.test(path))
  if (universal.length) return universal
  if (candidates.length <= 1) return candidates
  return selectFromOutputMetadata(candidates, variant, root, deviceSerial)
}

async function selectFromOutputMetadata(apks: string[], variant: string, root: string, deviceSerial?: string): Promise<string[]> {
  const metadataPath = join(apks[0], '..', 'output-metadata.json')
  let metadata: { variantName?: string; elements?: { filters?: { filterType?: string; value?: string }[]; outputFile?: string }[] }
  try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as typeof metadata }
  catch { throw Object.assign(new Error(`Multiple APKs found for ${variant}, but output-metadata.json is missing or invalid`), { code: 'apk_ambiguous' }) }
  if (metadata.variantName && metadata.variantName.toLowerCase() !== variant.toLowerCase()) throw Object.assign(new Error(`APK metadata is for ${metadata.variantName}, expected ${variant}`), { code: 'apk_variant_mismatch' })
  const outputs = metadata.elements ?? []
  const available = outputs.map((entry) => ({
    path: join(apks[0], '..', entry.outputFile ?? ''),
    filters: entry.filters ?? []
  })).filter((entry) => apks.includes(entry.path))
  if (available.some((entry) => entry.filters.length === 0)) return available.filter((entry) => entry.filters.length === 0).map((entry) => entry.path)
  if (!available.length) throw Object.assign(new Error(`No APK entries match variant ${variant} in output metadata`), { code: 'apk_not_found' })
  const device = deviceSerial ? await readDeviceProfile(root, deviceSerial) : null
  const abiFilters = available.flatMap((entry) => entry.filters.filter((filter) => filter.filterType === 'ABI').map((filter) => filter.value ?? ''))
  if (abiFilters.length && (!device?.abi || !abiFilters.includes(device.abi))) {
    throw Object.assign(new Error('Cannot select an ABI split without a connected device ABI'), { code: 'split_device_info_missing' })
  }
  const unfiltered = available.filter((entry) => entry.filters.length === 0)
  const filtered = available.filter((entry) => entry.filters.length > 0)
  const choices = new Map<string, string>()
  for (const entry of filtered) {
    for (const filter of entry.filters) {
      const type = filter.filterType ?? 'UNKNOWN'
      const value = filter.value ?? ''
      const current = choices.get(type)
      if (!current) choices.set(type, value)
      else if (type === 'ABI' && value === device?.abi) choices.set(type, value)
      else if (type === 'DENSITY' && densityScore(value, device?.density ?? 0) < densityScore(current, device?.density ?? 0)) choices.set(type, value)
      else if ((type === 'LANGUAGE' || type === 'LOCALE') && localeScore(value, device?.locale ?? '') > localeScore(current, device?.locale ?? '')) choices.set(type, value)
    }
  }
  const selected = [...unfiltered, ...filtered.filter((entry) => entry.filters.every((filter) => {
    const type = filter.filterType ?? 'UNKNOWN'
    return choices.get(type) === filter.value
  }))].map((entry) => entry.path)
  if (!selected.length) throw Object.assign(new Error(`No compatible APK splits found for device ${deviceSerial ?? '(unspecified)'}`), { code: 'apk_split_mismatch' })
  return selected
}

async function readDeviceProfile(root: string, serial: string): Promise<{ abi: string; density: number; locale: string } | null> {
  const keys = ['ro.product.cpu.abi', 'ro.sf.lcd_density', 'persist.sys.locale']
  const values: string[] = []
  for (const key of keys) {
    const result = await runCommand('adb', ['-s', serial, 'shell', 'getprop', key], root, undefined, 5000)
    if (result.exitCode !== 0) return null
    values.push(result.stdout.trim())
  }
  return { abi: values[0], density: Number(values[1]) || 0, locale: values[2] }
}

function densityScore(value: string, dpi: number): number {
  const standard: Record<string, number> = { ldpi: 120, mdpi: 160, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640 }
  const candidate = standard[value.toLowerCase()] ?? (Number(value) || 160)
  return Math.abs(candidate - (dpi || 160))
}

function localeScore(value: string, locale: string): number {
  const normalized = locale.toLowerCase().replace('_', '-')
  const candidate = value.toLowerCase().replace('_', '-')
  return candidate === normalized ? 2 : candidate === normalized.split('-')[0] ? 1 : 0
}
