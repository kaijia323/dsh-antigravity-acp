/**
 * DSH 会话 → ACP 会话 的映射缓存（只存 id 与已发送历史的指纹，不存对话内容）。
 *
 * 用途：`resumeSessions` 打开时，插件/宿主重启后还能找回上一次的 ACP 会话并
 * 用 `session/resume` 接回，而不是从零重建。历史权威仍是 DSH：这里只记录
 * 「哪些消息已经发给了那个 ACP 会话」，用于校验当前历史是否仍是它的纯追加。
 *
 * 缓存语义（刻意保守）：
 * - 只存 ID、条数与 sha256 指纹，绝不写入消息正文、系统提示或凭据；
 * - 读取失败、JSON 损坏、格式版本不符一律当作没有映射，静默回退重建；
 * - 条目按最近使用时间保留有限条，避免无限增长。
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** 单条会话映射；字段语义变化时提升 SESSION_MAP_FORMAT。 */
export interface SessionMapEntry {
  /** ACP 会话 id（官方 agent 分配）。 */
  sessionId: string
  /** 建立会话时的 cwd（恢复时校验一致）。 */
  cwd: string
  /** 已发送给该 ACP 会话的 DSH 消息条数。 */
  sentCount: number
  /** 前 sentCount 条消息的滚动指纹（sha256 hex）。 */
  sentHash: string
  /** 上一步实际交付的 assistant blocks 指纹；恢复时必须与 DSH 新增历史一致。 */
  outputHash: string
  /** 路由指纹：模型、思考强度、系统提示与工具目录。仅用于诊断；恢复时不再强制一致。 */
  route: string
  /** 最近一次成功发送的时间（毫秒）。 */
  updatedAt: number
}

interface SessionMapFile {
  format: number
  entries: Record<string, SessionMapEntry>
}

/** 映射文件格式版本。 */
const SESSION_MAP_FORMAT = 2
/** 会话映射条数上限：条目只存 id 与哈希，512 条足够长周期使用且避免文件无限增长。 */
const MAX_ENTRIES = 512
/** 默认文件名。 */
const FILE_NAME = 'sessions.json'

/** 读取会话映射；没有文件即首次运行，文件损坏直接抛错（没有「当空表」回退）。 */
export async function readSessionMap(cacheDir: string): Promise<Record<string, SessionMapEntry>> {
  const file = join(cacheDir, FILE_NAME)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed.format !== SESSION_MAP_FORMAT || typeof parsed.entries !== 'object' || parsed.entries === null) {
      throw new Error(`会话映射文件格式无效（format=${String(parsed?.format)}）: ${file}`)
    }
    const entries: Record<string, SessionMapEntry> = {}
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Partial<SessionMapEntry>
      if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
      if (typeof row.cwd !== 'string' || row.cwd === '') continue
      if (!Number.isSafeInteger(row.sentCount) || row.sentCount === undefined || row.sentCount < 0) continue
      if (!isHash(row.sentHash) || !isHash(row.outputHash) || !isHash(row.route)) continue
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      entries[key] = {
        sessionId: row.sessionId,
        cwd: row.cwd,
        sentCount: row.sentCount,
        sentHash: row.sentHash,
        outputHash: row.outputHash,
        route: row.route,
        updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      }
    }
    return entries
  } catch {
    return {}
  }
}

/**
 * 写入会话映射。写入失败（只读缓存目录、磁盘满、文件被占用）静默忽略：
 * 恢复能力是优化，不是功能。
 */
export async function writeSessionMap(cacheDir: string, entries: Record<string, SessionMapEntry>): Promise<boolean> {
  const kept = Object.entries(entries)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ENTRIES)
  const payload: SessionMapFile = { format: SESSION_MAP_FORMAT, entries: Object.fromEntries(kept) }
  const file = join(cacheDir, FILE_NAME)
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  let ownsTemporary = false
  try {
    await mkdir(dirname(file), { recursive: true })
    const handle = await open(temporary, 'wx', 0o600)
    ownsTemporary = true
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    ownsTemporary = false
    return true
  } catch {
    return false
  } finally {
    if (ownsTemporary) await unlink(temporary).catch(() => undefined)
  }
}

/** 检查锁文件中的 PID 是否仍在运行；已确认进程不存在（ESRCH）时视为死锁可安全清理。 */
function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 跨 Host 的排他写租约；另一存活实例持有缓存时，本实例仅保留内存复用，不读写恢复映射。
 * 若残留锁记录的 PID 已不存在（SIGKILL / 断电崩溃残留），自动清理并接管。
 */
export function createFileSessionMapStore(cacheDir: string, onError?: () => void): SessionMapStore {
  const file = join(cacheDir, 'sessions.lock')
  const marker = JSON.stringify({ pid: process.pid, token: randomUUID() })
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let ready = false
  return new SessionMapStore({
    load: async () => {
      await mkdir(cacheDir, { recursive: true })
      try {
        handle = await open(file, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const raw = await readFile(file, 'utf8').catch(() => '')
          let stale = false
          try {
            const parsed = JSON.parse(raw) as { pid?: unknown }
            stale = !isPidAlive(parsed?.pid)
          } catch {
            stale = false
          }
          if (stale && await readFile(file, 'utf8').catch(() => '') === raw) {
            await unlink(file).catch(() => undefined)
            handle = await open(file, 'wx', 0o600)
          } else {
            throw error
          }
        } else {
          throw error
        }
      }
      await handle.writeFile(marker, 'utf8')
      ready = true
      return readSessionMap(cacheDir)
    },
    save: async entries => {
      if (!ready || !await writeSessionMap(cacheDir, entries)) throw new Error('Session map unavailable')
    },
    onError,
    close: async () => {
      if (!handle) return
      ready = false
      const owned = handle
      handle = undefined
      await owned.close()
      // 只删除本实例确实创建、且内容仍匹配的锁；绝不清理其他 Host 的锁。
      if (await readFile(file, 'utf8').catch(() => '') === marker) await unlink(file).catch(() => undefined)
    },
  })
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export interface SessionMapStorage {
  load(): Promise<Record<string, SessionMapEntry>>
  save(entries: Record<string, SessionMapEntry>): Promise<void> | void
  onError?(): void
  close?(): Promise<void>
}

/**
 * 同一插件的所有 worker 共用一个存储：键的所有权与增量更新集中管理，写入串行化。
 * 连接池把同一对话换到另一 worker 时，接管只是换 owner 并**保留条目**，交给新 owner
 * 走 `session/resume` 接回；旧 worker 失去所有权后写入/删除都会被忽略。
 * 每次只更新调用方本轮的键，旧 worker 无法覆盖或删除新 owner 的状态。
 */
export class SessionMapStore {
  readonly #owners = new Map<string, symbol>()
  #entries: Record<string, SessionMapEntry> = {}
  #ready?: Promise<void>
  #writes: Promise<void> = Promise.resolve()
  #errorReported = false

  constructor(private readonly storage: SessionMapStorage) {}

  async claim(key: string, owner: symbol): Promise<SessionMapEntry | undefined> {
    this.#ready ??= this.storage.load().then(entries => { this.#entries = { ...entries } }, () => { this.#reportError() })
    await this.#ready
    // 换 worker 是连接池的正常行为（并发、空闲回收、标题请求都会换），不能因此
    // 删掉唯一的恢复映射：条目交给新 owner 走 session/resume 接回。旧 worker 下次
    // 处理该会话时 owns() 为假，会丢弃自己的内存记录但不再删磁盘条目。
    const entry = this.#entries[key]
    this.#owners.delete(key)
    this.#owners.set(key, owner)
    while (this.#owners.size > MAX_ENTRIES) {
      const oldest = this.#owners.keys().next().value
      if (oldest === undefined) break
      this.#owners.delete(oldest)
    }
    return entry ? { ...entry } : undefined
  }

  owns(key: string, owner: symbol): boolean { return this.#owners.get(key) === owner }

  set(key: string, owner: symbol, entry: SessionMapEntry): void {
    if (!this.owns(key, owner)) return
    this.#entries[key] = { ...entry }
    this.#entries = Object.fromEntries(Object.entries(this.#entries)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES))
    this.#enqueue()
  }

  delete(key: string, owner: symbol): void {
    if (!this.owns(key, owner)) return
    delete this.#entries[key]
    this.#enqueue()
  }

  /**
   * 无条件删除（不要求所有权）。仅供「宿主已删除该 DSH 会话」这类确定失效的场景：
   * 重启后 `#owners` 为空或所有权已转移时，普通 delete 会静默失效并留下陈旧映射。
   */
  async purge(key: string): Promise<void> {
    this.#ready ??= this.storage.load().then(entries => { this.#entries = { ...entries } }, () => { this.#reportError() })
    await this.#ready
    if (!(key in this.#entries)) return
    delete this.#entries[key]
    this.#enqueue()
  }

  /**
   * 只归还单个键的所有权，保留可恢复条目。
   *
   * 用于「认领了但这一轮没能走到 prompt 在途」的失败路径：条目本身没被否定
   * （例如恢复只是启动失败），下一个 worker 仍可以尝试接管它。
   */
  unclaim(key: string, owner: symbol): void {
    if (this.#owners.get(key) !== owner) return
    this.#owners.delete(key)
  }

  /** 卸载释放内存所有权但保留可恢复条目。 */
  release(owner: symbol): void {
    for (const [key, current] of this.#owners) if (current === owner) this.#owners.delete(key)
  }

  async flush(): Promise<void> { await this.#writes }

  async close(): Promise<void> {
    await this.#ready
    await this.flush()
    await this.storage.close?.()
  }

  #enqueue(): void {
    const snapshot = structuredClone(this.#entries)
    this.#writes = this.#writes.then(async () => {
      await this.storage.save(snapshot)
      this.#errorReported = false
    }).catch(() => { this.#reportError() })
  }

  #reportError(): void {
    if (!this.#errorReported) this.storage.onError?.()
    this.#errorReported = true
  }
}
