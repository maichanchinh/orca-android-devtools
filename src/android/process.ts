import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type CommandOutput = (stream: 'stdout' | 'stderr', chunk: string) => void

export function runCommand(command: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 30_000, onOutput?: CommandOutput): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Operation cancelled'), { code: 'cancelled' }))
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const collect = (target: 'stdout' | 'stderr', chunk: { toString(): string }) => {
      const next = chunk.toString()
      if (target === 'stdout') stdout = `${stdout}${next}`.slice(-1_000_000)
      else stderr = `${stderr}${next}`.slice(-1_000_000)
      try { onOutput?.(target, next) } catch { /* Logging must not interrupt the command. */ }
    }
    child.stdout?.on('data', (chunk: { toString(): string }) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk: { toString(): string }) => collect('stderr', chunk))
    const finish = (error?: Error, exitCode: number | null = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve({ exitCode, stdout, stderr })
    }
    const abort = () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1500)
      finish(Object.assign(new Error('Operation cancelled'), { code: 'cancelled' }))
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1500)
      finish(Object.assign(new Error(`Command timed out after ${timeoutMs} ms`), { code: 'timeout' }))
    }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => finish(Object.assign(error, { code: 'spawn_failed' })))
    child.once('close', (code) => finish(undefined, code))
  })
}

export async function runChecked(command: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<CommandResult> {
  const result = await runCommand(command, args, cwd, signal, timeoutMs)
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(`${command} ${args.join(' ')} failed (${result.exitCode ?? 'no exit code'})`), {
      code: 'command_failed',
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr}`
    })
  }
  return result
}

export async function runGradle(root: string, args: string[], signal?: AbortSignal, timeoutMs = 30_000, onOutput?: CommandOutput): Promise<CommandResult> {
  const wrapper = join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
  if (process.platform !== 'win32') return runCommand(wrapper, args, root, signal, timeoutMs, onOutput)
  const wrapperJar = join(root, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  try {
    await access(wrapperJar)
    return runCommand('java', ['-classpath', wrapperJar, 'org.gradle.wrapper.GradleWrapperMain', ...args], root, signal, timeoutMs, onOutput)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (process.platform === 'win32') throw Object.assign(new Error('Windows Gradle wrapper requires gradle/wrapper/gradle-wrapper.jar'), { code: 'gradle_wrapper_missing' })
    return runCommand(wrapper, args, root, signal, timeoutMs, onOutput)
  }
}
