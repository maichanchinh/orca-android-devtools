declare namespace NodeJS {
  interface ErrnoException extends Error { code?: string }
}

declare interface AndroidDevtoolsDirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

declare interface AndroidDevtoolsFileHandle {
  writeFile(data: string): Promise<void>
  close(): Promise<void>
}

declare interface AndroidDevtoolsChildProcess {
  stdout?: { on(event: 'data', listener: (chunk: { toString(): string }) => void): void }
  stderr?: { on(event: 'data', listener: (chunk: { toString(): string }) => void): void }
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null) => void): this
  kill(signal?: string): boolean
}

declare const process: {
  platform: string
  pid: number
  argv: string[]
  env: Record<string, string | undefined>
  exitCode?: number
  cwd(): string
  kill(pid: number, signal: number): boolean
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): typeof process
  stdout: { write(value: string): void }
  stderr: { write(value: string): void }
}

declare module 'node:fs/promises' {
  export function access(path: string): Promise<void>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string, encoding?: 'utf8'): Promise<void>
  export function mkdtemp(prefix: string): Promise<string>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  export function readdir(path: string, options: { withFileTypes: true }): Promise<AndroidDevtoolsDirent[]>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  export function open(path: string, flags: string): Promise<AndroidDevtoolsFileHandle>
  export function unlink(path: string): Promise<void>
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function relative(from: string, to: string): string
}

declare module 'node:child_process' {
  export type ChildProcess = AndroidDevtoolsChildProcess
  export function spawn(command: string, args: string[], options: {
    cwd: string
    shell: false
    windowsHide: boolean
    stdio: ['ignore', 'pipe', 'pipe']
  }): AndroidDevtoolsChildProcess
}

declare module 'node:crypto' {
  interface AndroidDevtoolsHash {
    update(value: string): AndroidDevtoolsHash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: string): AndroidDevtoolsHash
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}
