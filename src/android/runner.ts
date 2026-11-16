import { access, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { discoverDevices, findApkCandidates } from './discovery.ts'
import { runCommand, runChecked, runGradle } from './process.ts'
import type { CommandOutput } from './process.ts'
import type { AndroidDevice, RunOptions, RunResult } from './model.ts'
import { buildRemoteShellCommand, encodeIntentExtra, formatCommand } from './intent.ts'
import { defaultDebugSigningArgs, redactSigningArgs, redactSigningText } from './signing.ts'

const running = new Map<string, AbortController>()
const locks = new Map<string, Promise<void>>()

export interface RunProgress { stage: 'build' | 'install' | 'launch' | 'status' | 'error'; message: string }
export type RunProgressHandler = (progress: RunProgress) => void

export function cancelRun(runId: string): boolean {
  const controller = running.get(runId)
  if (!controller) return false
  controller.abort()
  return true
}

export async function executeRun(root: string, runId: string, options: RunOptions, signal?: AbortSignal, onProgress?: RunProgressHandler): Promise<RunResult> {
  const start = Date.now()
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  running.set(runId, controller)
  const logs: string[] = []
  const buildLogs: string[] = []
  const runLogs: string[] = []
  const report = (stage: RunProgress['stage'], message: string) => {
    const bounded = message.length > 4_000 ? `${message.slice(0, 4_000)}…` : message
    logs.push(bounded)
    if (logs.length > 200) logs.splice(0, logs.length - 200)
    const stageLogs = stage === 'build' ? buildLogs : runLogs
    stageLogs.push(bounded)
    if (stageLogs.length > 200) stageLogs.splice(0, stageLogs.length - 200)
    try { onProgress?.({ stage, message: bounded }) } catch { /* Observers must not fail a run. */ }
  }
  try {
    report('status', `Checking device ${options.device}…`)
    const devices = await discoverDevices(root)
    const device = selectDevice(devices, options.device)
    const keys = [`workspace:${root}`, `device:${device.serial}`]
    const release = await acquire(keys, controller.signal)
    try {
      const releaseFiles = await acquireProcessLocks(root, device.serial, controller.signal, options.timeoutMs)
      try {
      const apks = await buildOrFindApks(root, options, controller.signal, options.timeoutMs, report)
      if (!apks.length) throw Object.assign(new Error('No APK found for the selected module and variant'), { code: 'apk_not_found' })
      const metadata = await readApkMetadata(apks[0], root, controller.signal)
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(metadata.packageName)) {
        throw Object.assign(new Error(`Refusing unsafe package name: ${metadata.packageName}`), { code: 'invalid_package' })
      }
      const hasCustomIntent = !!options.activity || !!options.uri || !!options.launchFlags || options.extras.length > 0
      const useAndroidRun = options.install && !options.clearData && !hasCustomIntent && await supportsAndroidRun(root, controller.signal)
      if (useAndroidRun) {
        const runArgs = ['run', `--device=${device.serial}`, `--apks=${apks.join(',')}`]
        report('launch', `Installing and launching ${metadata.packageName} on ${device.serial}…`)
        report('launch', `Command: ${formatCommand('android', runArgs)}`)
        const result = await runCommand('android', runArgs, root, controller.signal, options.timeoutMs)
        appendCommandLines(report, 'launch', result.stdout, result.stderr)
        if (result.exitCode !== 0) throw Object.assign(new Error(`android run failed (${result.exitCode ?? 'no exit code'})`), { code: 'command_failed', exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` })
      } else if (options.install) {
        report('install', `Installing ${metadata.packageName} on ${device.serial}…`)
        await installApks(apks, device, root, controller.signal, options.timeoutMs, report)
        report('install', `Installed ${metadata.packageName} on ${device.serial}`)
      }
      if (options.clearData) {
        report('install', `Clearing app data for ${metadata.packageName}…`)
        const clearArgs = ['-s', device.serial, 'shell', buildRemoteShellCommand(['pm', 'clear', metadata.packageName])]
        report('install', `Command: ${formatCommand('adb', clearArgs)}`)
        const clear = await runChecked('adb', clearArgs, root, controller.signal, 30_000)
        appendCommandLines(report, 'install', clear.stdout, clear.stderr)
      }
      if (!useAndroidRun) {
        const activity = options.activity ?? metadata.launcherActivity
        if (!activity) throw Object.assign(new Error('Could not resolve launcher Activity from the APK manifest'), { code: 'activity_not_found' })
        const remoteArgs = ['am', 'start', '-n', `${metadata.packageName}/${normalizeActivity(metadata.packageName, activity)}`]
        if (options.uri) remoteArgs.push('-d', options.uri)
        if (options.launchFlags) remoteArgs.push('-f', options.launchFlags)
        for (const extra of options.extras) {
          remoteArgs.push(...encodeIntentExtra(extra))
        }
        const launchArgs = ['-s', device.serial, 'shell', buildRemoteShellCommand(remoteArgs)]
        report('launch', `Launching ${metadata.packageName}${options.uri ? ` with ${options.uri}` : ''}…`)
        report('launch', `Command: ${formatCommand('adb', launchArgs)}`)
        const launch = await runChecked('adb', launchArgs, root, controller.signal, 30_000)
        appendCommandLines(report, 'launch', launch.stdout, launch.stderr)
      }
      report('status', `Run completed on ${device.serial}`)
      return { status: 'success', exitCode: 0, durationMs: Date.now() - start, logs, buildLogs, runLogs, packageName: metadata.packageName }
      } finally {
        releaseFiles()
      }
    } finally {
      release()
    }
  } catch (error) {
    const issue = error as Error & { code?: string; exitCode?: number; output?: string }
    if (issue.output && !logs.length) appendCommandLines(report, 'error', issue.output)
    report('error', `${issue.code ?? 'run_failed'}: ${issue.message}`)
    return {
      status: issue.code === 'cancelled' ? 'cancelled' : 'failed',
      exitCode: issue.exitCode ?? null,
      durationMs: Date.now() - start,
      logs,
      buildLogs,
      runLogs,
      error: { code: issue.code ?? 'run_failed', message: issue.message }
    }
  } finally {
    running.delete(runId)
    signal?.removeEventListener('abort', cancel)
  }
}

function selectDevice(devices: AndroidDevice[], requested: string): AndroidDevice {
  if (requested) {
    const device = devices.find(({ serial }) => serial === requested)
    if (!device) throw Object.assign(new Error(`Selected device is not connected: ${requested}`), { code: 'device_not_found' })
    if (device.state !== 'device') throw Object.assign(new Error(device.state === 'unauthorized' ? `Authorize USB debugging for device ${device.serial}` : `Device ${device.serial} is ${device.state}`), { code: device.state === 'unauthorized' ? 'device_unauthorized' : 'device_offline' })
    return device
  }
  const online = devices.filter(({ state }) => state === 'device')
  if (online.length !== 1) throw Object.assign(new Error(online.length ? 'Select a device; multiple Android devices are connected' : 'No online Android device found'), { code: online.length ? 'device_ambiguous' : 'device_unavailable' })
  return online[0]
}

async function acquire(keys: string[], signal: AbortSignal): Promise<() => void> {
  const previous = keys.map((key) => locks.get(key) ?? Promise.resolve())
  let releaseLock!: () => void
  const hold = new Promise<void>((resolve) => { releaseLock = resolve })
  const combined = Promise.all(previous).then(() => hold)
  for (const key of keys) locks.set(key, combined)
  if (signal.aborted) {
    releaseLock()
    throw Object.assign(new Error('Operation cancelled'), { code: 'cancelled' })
  }
  let onAbort!: () => void
  try {
    await Promise.race([Promise.all(previous), new Promise<never>((_, reject) => {
      onAbort = () => reject(Object.assign(new Error('Operation cancelled'), { code: 'cancelled' }))
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  } catch (error) {
    releaseLock()
    for (const key of keys) if (locks.get(key) === combined) locks.delete(key)
    throw error
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
  return () => {
    releaseLock()
    for (const key of keys) if (locks.get(key) === combined) locks.delete(key)
  }
}

async function buildOrFindApks(root: string, options: RunOptions, signal: AbortSignal, timeoutMs: number, report: (stage: RunProgress['stage'], message: string) => void): Promise<string[]> {
  const release = options.variant.toLowerCase() === 'release'
  if (options.build || release) {
    const taskVariant = options.variant[0].toUpperCase() + options.variant.slice(1)
    report('build', `Building ${options.module}:assemble${taskVariant}…`)
    const gradleArgs = [`${options.module}:assemble${taskVariant}`]
    if (release) {
      const keystore = await ensureDefaultDebugKeystore(root, signal, report)
      gradleArgs.push(...defaultDebugSigningArgs(keystore))
    }
    gradleArgs.push('--console=plain')
    report('build', `Command: ${formatCommand('./gradlew', redactSigningArgs(gradleArgs))}`)
    const output = makeCommandOutput('build', (stage, message) => report(stage, redactSigningText(message)))
    const gradle = await runGradle(root, gradleArgs, signal, timeoutMs, output.onOutput)
    output.flush()
    if (gradle.exitCode !== 0) throw Object.assign(new Error(`Gradle build failed (${gradle.exitCode ?? 'no exit code'})`), { code: 'command_failed', exitCode: gradle.exitCode, output: redactSigningText(`${gradle.stdout}${gradle.stderr}`) })
  }
  report('status', `Locating APK for ${options.module} ${options.variant}…`)
  return findApkCandidates(root, options.module, options.variant, options.device)
}

async function ensureDefaultDebugKeystore(cwd: string, signal: AbortSignal, report: (stage: RunProgress['stage'], message: string) => void): Promise<string> {
  const keystore = join(homedir(), '.android', 'debug.keystore')
  try { await access(keystore); return keystore } catch { /* Create the Android SDK's standard local debug key on first use. */ }
  await mkdir(join(homedir(), '.android'), { recursive: true })
  const keytoolArgs = ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US', '-noprompt']
  report('build', `Creating Android default debug keystore at ${keystore}`)
  const safeKeytoolArgs = keytoolArgs.map((arg, index) => ['-storepass', '-keypass'].includes(keytoolArgs[index - 1]) ? '<redacted>' : arg)
  report('build', `Command: ${formatCommand('keytool', safeKeytoolArgs)}`)
  const created = await runCommand('keytool', keytoolArgs, cwd, signal, 30_000)
  if (created.exitCode !== 0) throw Object.assign(new Error(`Could not create Android default debug keystore (${created.exitCode ?? 'no exit code'}): ${redactSigningText(created.stderr || created.stdout)}`), { code: 'debug_keystore_unavailable', exitCode: created.exitCode })
  return keystore
}

async function installApks(apks: string[], device: AndroidDevice, cwd: string, signal: AbortSignal, timeoutMs: number, report: (stage: RunProgress['stage'], message: string) => void): Promise<void> {
  const help = await runCommand('android', ['install', '--help'], cwd, signal, 5000)
  if (help.exitCode === 0 && /--device=/.test(`${help.stdout}${help.stderr}`) && /--apks=/.test(`${help.stdout}${help.stderr}`)) {
    const cliArgs = ['install', `--device=${device.serial}`, `--apks=${apks.join(',')}`]
    report('install', `Command: ${formatCommand('android', cliArgs)}`)
    const cli = await runCommand('android', cliArgs, cwd, signal, timeoutMs)
    if (cli.exitCode === 0) {
      appendCommandLines(report, 'install', cli.stdout, cli.stderr)
      return
    }
    if (cli.exitCode === null && signal.aborted) throw Object.assign(new Error('Operation cancelled'), { code: 'cancelled' })
    appendCommandLines(report, 'install', `android install unavailable; falling back to adb`, cli.stdout, cli.stderr)
  }
  const adbArgs = ['-s', device.serial, apks.length > 1 ? 'install-multiple' : 'install', '-r', ...apks]
  report('install', `Command: ${formatCommand('adb', adbArgs)}`)
  const adb = await runChecked('adb', adbArgs, cwd, signal, timeoutMs)
  appendCommandLines(report, 'install', adb.stdout, adb.stderr)
}

async function supportsAndroidRun(cwd: string, signal: AbortSignal): Promise<boolean> {
  const help = await runCommand('android', ['run', '--help'], cwd, signal, 5000)
  const output = `${help.stdout}${help.stderr}`
  return help.exitCode === 0 && /--device=/.test(output) && /--apks=/.test(output)
}

function makeCommandOutput(stage: RunProgress['stage'], report: (stage: RunProgress['stage'], message: string) => void): { onOutput: CommandOutput; flush: () => void } {
  let pending = ''
  const emit = (line: string) => { if (line.trim()) report(stage, line) }
  return {
    onOutput: (_stream, chunk) => {
      const parts = `${pending}${chunk}`.split(/\r?\n/)
      pending = (parts.pop() ?? '').slice(-4_000)
      parts.forEach(emit)
    },
    flush: () => { emit(pending); pending = '' }
  }
}

function appendCommandLines(report: (stage: RunProgress['stage'], message: string) => void, stage: RunProgress['stage'], ...parts: string[]): void {
  for (const line of lines(...parts)) report(stage, line)
}

async function readApkMetadata(apk: string, cwd: string, signal: AbortSignal): Promise<{ packageName: string; launcherActivity?: string }> {
  const sdk = await findAndroidSdk(cwd)
  const toolName = process.platform === 'win32' ? 'aapt.exe' : 'aapt'
  const buildTools = sdk ? await newestTool(join(sdk, 'build-tools'), toolName) : undefined
  let result
  try {
    result = await runChecked(buildTools ?? 'aapt', ['dump', 'badging', apk], cwd, signal, 15_000)
  } catch (error) {
    const issue = error as Error & { code?: string }
    if (!buildTools || issue.code !== 'spawn_failed') throw error
    result = await runChecked('aapt', ['dump', 'badging', apk], cwd, signal, 15_000)
  }
  const packageMatch = result.stdout.match(/^package: name='([^']+)'/m)
  const activityMatch = result.stdout.match(/^launchable-activity: name='([^']+)'/m)
  if (!packageMatch) throw Object.assign(new Error('Could not read applicationId from APK metadata'), { code: 'package_not_found' })
  return { packageName: packageMatch[1], launcherActivity: activityMatch?.[1] }
}

async function newestTool(directory: string, tool: string): Promise<string | undefined> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) {
      const candidate = join(directory, version, tool)
      try { await access(candidate); return candidate } catch { /* Try the next installed Build Tools version. */ }
    }
    return undefined
  } catch { return undefined }
}

async function findAndroidSdk(root: string): Promise<string | undefined> {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  try {
    const properties = await readFile(join(root, 'local.properties'), 'utf8')
    const sdkDir = properties.match(/^\s*sdk\.dir\s*=\s*(.+?)\s*$/m)?.[1]
    if (sdkDir) candidates.push(sdkDir.replace(/\\([ :\\])/g, '$1'))
  } catch { /* Environment variables remain the fallback for standalone projects. */ }
  if (process.platform === 'darwin') candidates.push(join(process.env.HOME ?? '', 'Library', 'Android', 'sdk'))
  else if (process.platform === 'win32') candidates.push(join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'))
  else candidates.push(join(process.env.HOME ?? '', 'Android', 'Sdk'))
  for (const candidate of candidates) {
    if (!candidate) continue
    const path = resolve(root, candidate)
    try { await access(join(path, 'build-tools')); return path } catch { /* Continue through SDK path sources. */ }
  }
  return undefined
}

function normalizeActivity(packageName: string, activity: string): string {
  if (activity.startsWith('.')) return `${packageName}${activity}`
  if (!activity.includes('.')) return `${packageName}.${activity}`
  return activity
}

async function acquireProcessLocks(root: string, serial: string, signal: AbortSignal, timeoutMs: number): Promise<() => void> {
  const deviceKey = createHash('sha256').update(serial).digest('hex')
  const rootLock = join(root, '.gradle', 'android-devtools.lock')
  const deviceDirectory = join(tmpdir(), 'android-devtools-locks')
  await mkdir(deviceDirectory, { recursive: true })
  const releaseRoot = await acquireFileLock(rootLock, signal, timeoutMs)
  try {
    const releaseDevice = await acquireFileLock(join(deviceDirectory, `${deviceKey}.lock`), signal, timeoutMs)
    return () => { releaseDevice(); releaseRoot() }
  } catch (error) {
    releaseRoot()
    throw error
  }
}

async function acquireFileLock(path: string, signal: AbortSignal, timeoutMs: number): Promise<() => void> {
  const deadline = Date.now() + timeoutMs
  while (!signal.aborted && Date.now() < deadline) {
    try {
      await mkdir(join(path, '..'), { recursive: true })
      const handle = await open(path, 'wx')
      await handle.writeFile(String(process.pid))
      return () => { void handle.close().finally(() => unlink(path).catch(() => undefined)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const pid = Number(await readFile(path, 'utf8'))
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) } catch (issue) {
            if ((issue as NodeJS.ErrnoException).code === 'ESRCH') await unlink(path).catch(() => undefined)
          }
        }
      } catch (issue) {
        if ((issue as NodeJS.ErrnoException).code === 'ENOENT') continue
      }
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          if (error) reject(error)
          else resolve()
        }
        const timer = setTimeout(() => finish(), 200)
        const abort = () => finish(Object.assign(new Error('Operation cancelled'), { code: 'cancelled' }))
        signal.addEventListener('abort', abort, { once: true })
      })
    }
  }
  throw Object.assign(new Error(signal.aborted ? 'Operation cancelled' : 'Timed out waiting for another Android Devtools run'), { code: signal.aborted ? 'cancelled' : 'lock_timeout' })
}

function lines(...parts: string[]): string[] {
  return parts.join('\n').split(/\r?\n/).filter(Boolean).slice(-150)
}
