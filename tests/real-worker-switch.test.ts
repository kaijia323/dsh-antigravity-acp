/**
 * 真机实验：连接池换 worker / 空闲回收 / 改变思考强度 之后仍能继续会话。
 *
 * 这是 2026-11-19 fork.2 修复的核心场景：旧实现在 claim（owner 变化）、路由指纹
 * 变化、恢复校验失败等路径删除磁盘映射，随后因为「不重放历史」永久报
 * AGY_SESSION_UNRECOVERABLE。这里用真实 agy ACP 进程验证三条路径都不会再判死。
 *
 * 默认 skip：只有 AGY_REAL_ACP=1 时运行，每次运行消耗账号额度。
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSessionMapStore } from '../src/runtime/session-map.js'
import { createRealAdapter } from './helpers/real-adapter.js'

const ENABLED = process.env.AGY_REAL_ACP === '1'
const MODEL = process.env.AGY_REAL_MODEL ?? 'gemini-4-neon'

function sid(value: string): NonNullable<GenerateOptions['sessionId']> {
  return brandString(value as NonNullable<GenerateOptions['sessionId']>)
}
function userTurn(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
async function drain(stream: AsyncIterable<StreamChunk>) {
  const blocks: ContentBlock[] = []
  let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  let error: string | undefined
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (thrown) {
    error = thrown instanceof Error ? `${(thrown as { code?: string }).code ?? ''} ${thrown.message}`.trim() : String(thrown)
  }
  return { blocks, finish, error }
}
function failCode(result: Awaited<ReturnType<typeof drain>>): string {
  if (result.finish?.kind === 'error') return result.finish.failure.code ?? result.finish.failure.message
  return result.error ?? ''
}
function assistantTurn(blocks: ContentBlock[], model: string): RequestMessage[] {
  return blocks.length > 0
    ? [createAssistantMessage({ content: blocks, source: { provider: 'antigravity-acp', model } })]
    : []
}
async function cacheDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'agy-worker-switch-'))
}

describe.skipIf(!ENABLED)('会话映射在 worker 切换 / 空闲回收 / 路由变化后仍可恢复', () => {
  it('进程 A 建会话 → 进程 B 接管同一 DSH 会话继续（不报不可恢复）', async () => {
    const dir = await cacheDir()
    const store = createFileSessionMapStore(dir, () => undefined)
    const base: GenerateOptions = {
      provider: 'antigravity-acp', model: MODEL, reasoningEffort: 'low' as never, sessionId: sid('session-worker-switch'), messages: [],
    }
    const first = await createRealAdapter({ cwd: '/tmp', store, closeStore: false, parkSettleMs: 400, promptTimeoutMs: 180_000 })
    try {
      await first.adapter.prepareCall('antigravity-acp', MODEL)
      const opening = userTurn('只回两个字：收到')
      const r1 = await drain(first.adapter.stream({ ...base, messages: [opening] }))
      expect(failCode(r1)).toBe('')
      const history: RequestMessage[] = [opening, ...assistantTurn(r1.blocks, MODEL)]

      // 连接池把同一对话换到另一个 worker：B 与 A 共用同一映射存储、A 的进程仍然活着。
      const second = await createRealAdapter({ cwd: '/tmp', store, closeStore: false, parkSettleMs: 400, promptTimeoutMs: 180_000 })
      try {
        await second.adapter.prepareCall('antigravity-acp', MODEL)
        const r2 = await drain(second.adapter.stream({ ...base, messages: [...history, userTurn('刚才让你做什么？只回关键动词')] }))
        const logs = second.logs.map((line) => line.message).join('\n')
        console.log('[换 worker] finish =', JSON.stringify(r2.finish), '| error =', r2.error ?? '-')
        console.log('[换 worker] 日志:\n' + logs.split('\n').filter((line) => /恢复|复用|放弃|失败|映射/.test(line)).join('\n'))
        expect(failCode(r2)).not.toContain('AGY_SESSION_UNRECOVERABLE')
        expect(logs).toContain('已恢复 ACP 会话')
      } finally {
        await second.dispose()
      }
    } finally {
      await first.dispose()
      await store.close().catch(() => undefined)
    }
  }, 900_000)

  it('空闲回收进程后，下一轮按 session/resume 接回（不报不可恢复）', async () => {
    const dir = await cacheDir()
    const base: GenerateOptions = {
      provider: 'antigravity-acp', model: MODEL, reasoningEffort: 'low' as never, sessionId: sid('session-idle-recycle'), messages: [],
    }
    const adapter = await createRealAdapter({ cwd: '/tmp', cacheDir: dir, idleRecycleMs: 600, parkSettleMs: 400, promptTimeoutMs: 180_000 })
    try {
      await adapter.adapter.prepareCall('antigravity-acp', MODEL)
      const opening = userTurn('只回两个字：收到')
      const r1 = await drain(adapter.adapter.stream({ ...base, messages: [opening] }))
      expect(failCode(r1)).toBe('')
      const history: RequestMessage[] = [opening, ...assistantTurn(r1.blocks, MODEL)]
      // 等空闲回收真正发生。
      await new Promise((done) => setTimeout(done, 2_000))
      const recycled = adapter.logs.some((line) => /空闲|回收/.test(line.message))
      console.log('[空闲回收] 是否观察到回收日志:', recycled, '| 日志条数', adapter.logs.length)
      const r2 = await drain(adapter.adapter.stream({ ...base, messages: [...history, userTurn('刚才让你做什么？只回关键动词')] }))
      const logs = adapter.logs.map((line) => line.message).join('\n')
      console.log('[空闲回收] finish =', JSON.stringify(r2.finish), '| error =', r2.error ?? '-')
      console.log('[空闲回收] 日志:\n' + logs.split('\n').filter((line) => /恢复|复用|放弃|失败|回收/.test(line)).join('\n'))
      expect(failCode(r2)).not.toContain('AGY_SESSION_UNRECOVERABLE')
      expect(logs).toContain('已恢复 ACP 会话')
    } finally {
      await adapter.dispose()
    }
  }, 900_000)

  it('同一会话中途改变思考强度：就地切换，不重建也不报不可恢复', async () => {
    const dir = await cacheDir()
    const base: GenerateOptions = {
      provider: 'antigravity-acp', model: MODEL, reasoningEffort: 'low' as never, sessionId: sid('session-effort-switch'), messages: [],
    }
    const adapter = await createRealAdapter({ cwd: '/tmp', cacheDir: dir, parkSettleMs: 400, promptTimeoutMs: 180_000 })
    try {
      await adapter.adapter.prepareCall('antigravity-acp', MODEL)
      const opening = userTurn('只回两个字：收到')
      const r1 = await drain(adapter.adapter.stream({ ...base, messages: [opening] }))
      expect(failCode(r1)).toBe('')
      const history: RequestMessage[] = [opening, ...assistantTurn(r1.blocks, MODEL)]
      const r2 = await drain(adapter.adapter.stream({
        ...base,
        reasoningEffort: 'high' as never,
        messages: [...history, userTurn('刚才让你做什么？只回关键动词')],
      }))
      const logs = adapter.logs.map((line) => line.message).join('\n')
      console.log('[改档位] finish =', JSON.stringify(r2.finish), '| error =', r2.error ?? '-')
      console.log('[改档位] 日志:\n' + logs.split('\n').filter((line) => /恢复|复用|放弃|失败|模型|档位/.test(line)).join('\n'))
      expect(failCode(r2)).not.toContain('AGY_SESSION_UNRECOVERABLE')
    } finally {
      await adapter.dispose()
    }
  }, 900_000)
})
