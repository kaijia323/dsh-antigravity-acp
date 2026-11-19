import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFileSessionMapStore, readSessionMap, SessionMapStore, writeSessionMap } from '../src/runtime/session-map.js'
import type { SessionMapEntry } from '../src/runtime/session-map.js'

const dirs: string[] = []
async function directory() { const path = await mkdtemp(join(tmpdir(), 'agy-session-map-')); dirs.push(path); return path }
afterEach(async () => {
  for (const path of dirs.splice(0)) {
    const absolute = resolve(path)
    if (!absolute.startsWith(resolve(tmpdir())) || !absolute.includes('agy-session-map-')) throw new Error('Unexpected test cleanup path')
    await rm(absolute, { recursive: true, force: true })
  }
})
function entry(index = 1): SessionMapEntry {
  return { sessionId: `acp-${index}`, cwd: '/workspace', sentCount: index, sentHash: 'a'.repeat(64), outputHash: 'b'.repeat(64), route: 'c'.repeat(64), updatedAt: index }
}

describe('会话映射文件', () => {
  it('往返、只存指纹、缺文件与坏 JSON 安全降级', async () => {
    const dir = await directory()
    expect(await readSessionMap(dir)).toEqual({})
    expect(await writeSessionMap(dir, { chat: entry() })).toBe(true)
    expect(await readSessionMap(dir)).toEqual({ chat: entry() })
    expect(await readdir(dir)).toEqual(['sessions.json'])
    const text = await readFile(join(dir, 'sessions.json'), 'utf8')
    expect(JSON.parse(text).format).toBe(2)
    expect(text).not.toContain('system')
    await writeFile(join(dir, 'sessions.json'), '{')
    expect(await readSessionMap(dir)).toEqual({})
  })
  it('拒绝旧格式、非法计数/指纹，只保留有效条目', async () => {
    const dir = await directory()
    const file = join(dir, 'sessions.json')
    await writeFile(file, JSON.stringify({ format: 1, entries: { old: entry() } }))
    expect(await readSessionMap(dir)).toEqual({})
    await writeFile(file, JSON.stringify({ format: 2, entries: {
      good: entry(), negative: { ...entry(), sentCount: -1 }, fractional: { ...entry(), sentCount: 0.5 },
      invalid: { ...entry(), outputHash: 'bogus' }, missing: { ...entry(), route: null },
    } }))
    expect(await readSessionMap(dir)).toEqual({ good: entry() })
  })
  })

describe('跨 Host 文件租约', () => {
  it('并发实例不读取/覆盖另一实例的映射，关闭外来实例不删除原租约', async () => {
    const dir = await directory(), warning = vi.fn()
    const first = createFileSessionMapStore(dir), second = createFileSessionMapStore(dir, warning)
    const a = Symbol(), b = Symbol()
    try {
      await first.claim('chat', a); first.set('chat', a, entry(1)); await first.flush()
      expect(await second.claim('chat', b)).toBeUndefined()
      second.set('chat', b, entry(3)); second.set('other', b, entry(4)); await second.flush()
      expect(await readSessionMap(dir)).toEqual({ chat: entry(1) })
      expect(warning).toHaveBeenCalledTimes(1)
      await second.close()
      expect(await readdir(dir)).toContain('sessions.lock')
    } finally { await first.close(); await second.close() }
    expect(await readdir(dir)).toEqual(['sessions.json'])
    const restarted = createFileSessionMapStore(dir)
    try { expect(await restarted.claim('chat', Symbol())).toEqual(entry(1)) }
    finally { await restarted.close() }
  })
})

describe('共享 SessionMapStore 所有权与串行提交', () => {
  it('并发 claim/set 不丢条目，save 严格串行且快照隔离', async () => {
    let disk: Record<string, SessionMapEntry> = {}, active = 0, maximum = 0
    const store = new SessionMapStore({ load: async () => ({}), save: async rows => {
      maximum = Math.max(maximum, ++active)
      await new Promise<void>(done => setTimeout(done, 2))
      disk = rows; active--
    } })
    const a = Symbol(), b = Symbol()
    await Promise.all([store.claim('a', a), store.claim('b', b)])
    store.set('a', a, entry(1)); store.set('b', b, entry(2)); await store.flush()
    expect(maximum).toBe(1)
    expect(disk).toEqual({ a: entry(1), b: entry(2) })
  })
  it('换 owner 时接管条目而不是删除；旧 worker 不得覆盖或删除已被接管的键', async () => {
    let disk: Record<string, SessionMapEntry> = {}
    const store = new SessionMapStore({ load: async () => ({}), save: rows => { disk = rows } })
    const a = Symbol(), b = Symbol()
    await store.claim('chat', a); store.set('chat', a, entry(1))
    // 连接池换 worker 是正常现象：接管必须返回条目供 session/resume 接回，不能删。
    expect(await store.claim('chat', b)).toEqual(entry(1))
    store.set('chat', b, entry(3)); store.set('chat', a, entry(1)); store.delete('chat', a)
    await store.claim('other', a); store.set('other', a, entry(2)); await store.flush()
    expect(disk.chat?.sentCount).toBe(3)
    expect(disk.other?.sentCount).toBe(2)
  })

  it('purge 无条件删除陈旧映射：重启后 owner 表为空也能删掉', async () => {
    let disk = { chat: entry(1) } as Record<string, SessionMapEntry>
    const store = new SessionMapStore({ load: async () => disk, save: rows => { disk = rows } })
    await store.purge('chat')
    await store.flush()
    expect(disk.chat).toBeUndefined()
    // 不存在的键是空操作，不新增条目。
    await store.purge('missing')
    await store.flush()
    expect(disk).toEqual({})
  })

  it('接管不丢磁盘映射：新 owner 尚未写入前，原条目仍在', async () => {
    let disk: Record<string, SessionMapEntry> = {}
    const store = new SessionMapStore({ load: async () => ({}), save: rows => { disk = rows } })
    const a = Symbol(), b = Symbol()
    await store.claim('chat', a); store.set('chat', a, entry(1)); await store.flush()
    expect(await store.claim('chat', b)).toEqual(entry(1))
    await store.flush()
    expect(disk.chat).toEqual(entry(1))
    // 旧 owner 已失去所有权：写入与删除都应被忽略。
    store.delete('chat', a)
    expect(await store.claim('chat', Symbol())).toEqual(entry(1))
  })
  it('卸载 release 保留磁盘记录，新的 owner 可恢复；坏写入不毒化队列', async () => {
    let disk = { chat: entry(1) } as Record<string, SessionMapEntry>
    const onError = vi.fn(), save = vi.fn().mockRejectedValueOnce(new Error('full')).mockImplementation(async rows => { disk = rows })
    const store = new SessionMapStore({ load: async () => disk, save, onError })
    const a = Symbol(), b = Symbol()
    expect(await store.claim('chat', a)).toEqual(entry(1))
    store.set('chat', a, entry(2)); await store.flush()
    expect(onError).toHaveBeenCalledTimes(1)
    store.set('chat', a, entry(3)); await store.flush(); store.release(a)
    expect(await store.claim('chat', b)).toEqual(entry(3))
    expect(disk.chat).toEqual(entry(3))
  })

  it('unclaim 只归还所有权并保留条目，失败路径不会把键永久挂在本 worker 名下', async () => {
    const disk = { chat: entry(1) } as Record<string, SessionMapEntry>
    const store = new SessionMapStore({ load: async () => disk, save: rows => { Object.assign(disk, rows) } })
    const a = Symbol(), b = Symbol()
    expect(await store.claim('chat', a)).toEqual(entry(1))
    expect(store.owns('chat', a)).toBe(true)
    store.unclaim('chat', a)
    expect(store.owns('chat', a)).toBe(false)
    // 另一个 worker 立刻可以接管同一条目（条目内容没被否定）。
    expect(await store.claim('chat', b)).toEqual(entry(1))
    expect(store.owns('chat', b)).toBe(true)
    // 非 owner 的 unclaim 是空操作，不会抢走当前所有权。
    store.unclaim('chat', a)
    expect(store.owns('chat', b)).toBe(true)
  })
})
