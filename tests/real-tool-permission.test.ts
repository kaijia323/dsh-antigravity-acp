/**
 * 真机回归：MCP 工具权限握手（1.5.13 `agy acp` 形状）。
 *
 * 历史故障（2026-11-20 20:26，会话 1e99d2c5）：1.5.13 Go 版 ACP server 的
 * `session/request_permission` 不再带 `_meta.is_mcp_tool_call`，而是
 * `toolCall.name = "mcp_<server>_<tool>"`、`title = "Run mcp_<server>_<tool>"`
 * （无问号）。旧解析器只认元数据与旧 "Run <tool>?" 标题，于是把私有桥工具
 * 当成原生请求拒绝；服务端随即升级为工具确认失败并取消 cascade，回合只剩
 * 思考、没有文本，插件报 `AGY_EMPTY_RESPONSE`——用户看到的就是「本轮运行失败」。
 *
 * 本用例必须走与生产一致的启动参数（不带 --dangerously-skip-permissions），
 * 先断言工具续轮，再断言回填结果后能正常收尾。默认 skip：`AGY_REAL_ACP=1` 才跑。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { createRealAdapter, type RealAdapter } from './helpers/real-adapter.js'

const ENABLED = process.env.AGY_REAL_ACP === '1'
const MODEL = process.env.AGY_REAL_MODEL ?? 'gemini-4-neon'

const ECHO_TOOL: ToolSchema = {
  name: 'echo_probe',
  description: '回显传入的 text。本会话里这是唯一可用的工具。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
}

const instances: RealAdapter[] = []
afterAll(async () => { for (const item of instances) await item.dispose() })

function userTurn(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<{ blocks: ContentBlock[]; finish?: Extract<StreamChunk, { type: 'finish' }>['reason']; error?: string }> {
  const blocks: ContentBlock[] = []
  let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  let error: string | undefined
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
      if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }
  return { blocks, finish, error }
}

function sessionId(value: string): NonNullable<GenerateOptions['sessionId']> {
  return brandString(value as never)
}

describe.skipIf(!ENABLED)('真机回归：1.5.13 MCP 权限握手后工具续轮可用', () => {
  it('授权 → tool-calls → 回填结果 → stop 且带工具输出', async () => {
    const target = await createRealAdapter({ cwd: '/tmp', parkSettleMs: 400, promptTimeoutMs: 180_000 })
    instances.push(target)
    await target.adapter.prepareCall('antigravity-acp', MODEL)
    const base: GenerateOptions = {
      provider: 'antigravity-acp', model: MODEL, reasoningEffort: 'low' as never,
      tools: [ECHO_TOOL], messages: [], sessionId: sessionId('session-real-tool-permission'),
    }
    const ask = userTurn('请调用 echo_probe 工具，把 text 设为 "ping"。只做这一步，不要解释。')
    const first = await drain(target.adapter.stream({ ...base, messages: [ask] }))
    const logs = (): string => target.logs.map((line) => line.message).join('\n')
    // 权限必须被识别为私有桥（否则本轮会以 AGY_EMPTY_RESPONSE 结束）。
    expect(logs()).toContain('已允许私有 MCP 桥')
    expect(first.finish?.kind, `未进入工具续轮：${JSON.stringify(first.finish)} 日志=${logs()}`).toBe('tool-calls')
    const call = first.blocks.find((block) => block.type === 'tool-call')
    expect(call?.type).toBe('tool-call')

    const history: RequestMessage[] = [
      ask,
      createAssistantMessage({ content: [...first.blocks], source: { provider: 'antigravity-acp', model: MODEL } }),
      createToolResultMessage({ callId: ToolCallId(String((call as { id: string }).id)), content: [{ type: 'text', text: 'pong:ping' }], isError: false }),
    ]
    const second = await drain(target.adapter.stream({ ...base, messages: history }))
    expect(second.finish?.kind, `续轮未正常收尾：${JSON.stringify(second.finish)} 日志=${logs()}`).toBe('stop')
    const text = second.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('')
    expect(text).toContain('pong:ping')
  }, 900_000)
})
