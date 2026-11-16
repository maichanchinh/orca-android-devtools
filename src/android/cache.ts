export class AsyncTtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>()
  private readonly pending = new Map<string, Promise<T>>()

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  async get(key: string, load: () => Promise<T>, refresh = false): Promise<T> {
    const cached = this.entries.get(key)
    if (!refresh && cached && cached.expiresAt > this.now()) return cached.value
    if (!refresh) {
      const pending = this.pending.get(key)
      if (pending) return pending
    }
    const request = load().then((value) => {
      this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
      return value
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key)
    })
    this.pending.set(key, request)
    return request
  }

  has(key: string): boolean {
    const cached = this.entries.get(key)
    return !!cached && cached.expiresAt > this.now()
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear()
    else this.entries.delete(key)
  }

  clear(): void { this.invalidate() }
}

export interface PersistentStorage {
  get(key: string): Promise<unknown | null>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface PersistentCacheResult<T> {
  value: T
  source: 'memory' | 'storage' | 'loaded'
}

export class PersistentCache<T> {
  private readonly entries = new Map<string, T>()
  private readonly pending = new Map<string, Promise<PersistentCacheResult<T>>>()
  private readonly generations = new Map<string, number>()

  constructor(
    private readonly storage: PersistentStorage,
    private readonly prefix: string,
    private readonly decode: (value: unknown) => T | undefined
  ) {}

  async get(key: string, load: () => Promise<T>, refresh = false): Promise<PersistentCacheResult<T>> {
    if (refresh) await this.invalidate(key)
    else {
      const cached = this.entries.get(key)
      if (cached !== undefined) return { value: cached, source: 'memory' }
      const pending = this.pending.get(key)
      if (pending) return pending
    }

    const generation = this.generations.get(key) ?? 0
    const request = (async (): Promise<PersistentCacheResult<T>> => {
      if (!refresh) {
        try {
          const stored = this.decode(await this.storage.get(this.storageKey(key)))
          if (stored !== undefined && generation === (this.generations.get(key) ?? 0)) {
            this.entries.set(key, stored)
            return { value: stored, source: 'storage' }
          }
        } catch { /* A failed cache read falls back to normal project discovery. */ }
      }
      const value = await load()
      if (generation === (this.generations.get(key) ?? 0)) {
        this.entries.set(key, value)
        try { await this.storage.set(this.storageKey(key), value) } catch { /* Discovery remains usable if persistence is unavailable. */ }
      }
      return { value, source: 'loaded' }
    })().finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key)
    })
    this.pending.set(key, request)
    return request
  }

  async invalidate(key: string): Promise<void> {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    this.entries.delete(key)
    this.pending.delete(key)
    try { await this.storage.delete(this.storageKey(key)) } catch { /* The in-memory entry is still invalidated. */ }
  }

  private storageKey(key: string): string { return `${this.prefix}:${encodeURIComponent(key)}` }
}
