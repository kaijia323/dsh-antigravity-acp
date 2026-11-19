/**
 * prompt 组装：历史重放说明 + 当前请求强调。
 *
 * 普通聊天轮要么复用会话只发增量，要么直接报错，不再重放历史；只有压缩这类
 * 一次性请求会把整段对话交过来。此时「历史只是背景」的说明必须存在，而首次
 * 聊天（只有用户消息与注入块）不该出现「重放」措辞。
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  boundedHistory,
  buildPromptContent,
  currentRequestBlock,
  hasPriorConversation,
  HISTORY_OPEN,
  latestUserRequest,
  parsePromptTranscript,
  TOOL_POLICY_TEXT,
} from '../src/adapter/prompt-transcript.js'

function user(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** DSH 在用户消息之后追加的注入块：role 仍是 user，但 source.kind 不是 user。 */
function injected(text: string, kind: string): RequestMessage {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind } } as unknown as RequestMessage
}

function textOf(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
}

describe('当前请求强调', () => {
  it('取最新真实用户消息，而不是其后追加的时间/运行时注入块', () => {
    const messages = [
      user('把 Google 那个改成 AI Studio'),
      injected('准备第 8 轮、第 1 步时采样的时间：…', 'time-context'),
      injected('Current runtime context. This snapshot supersedes…', 'runtime-context'),
    ]
    expect(latestUserRequest(messages)?.content).toEqual([{ type: 'text', text: '把 Google 那个改成 AI Studio' }])

    const current = textOf(buildPromptContent(undefined, messages)).at(-1)
    expect(current?.startsWith('<dsh-current-request>')).toBe(true)
    expect(current).toContain('把 Google 那个改成 AI Studio')
    expect(current).not.toContain('准备第 8 轮')
    expect(current).not.toContain('Current runtime context')
  })

  it('当前请求块位于最后，历史说明块位于所有消息信封之前', () => {
    const blocks = buildPromptContent(undefined, [
      user('第一问'),
      createToolResultMessage({ callId: ToolCallId('call-a'), content: [{ type: 'text', text: '结果' }], isError: false }),
      injected('快照', 'time-context'),
    ])
    const texts = textOf(blocks)
    const historyIndex = texts.findIndex((text) => text.startsWith(HISTORY_OPEN))
    const currentIndex = texts.findIndex((text) => text.startsWith('<dsh-current-request>'))
    const firstEnvelope = texts.findIndex((text) => text.startsWith('<dsh-message role="'))
    expect(historyIndex).toBeGreaterThanOrEqual(0)
    expect(historyIndex).toBeLessThan(firstEnvelope)
    expect(currentIndex).toBe(texts.length - 1)
  })

  it('两个说明块都不参与消息逆解析，当前请求不会重复计入 entries', () => {
    const messages: RequestMessage[] = [
      user('第一问'),
      createToolResultMessage({ callId: ToolCallId('call-a'), content: [{ type: 'text', text: '结果' }], isError: false }),
      injected('第 2 轮时间快照', 'time-context'),
    ]
    const blocks = buildPromptContent('系统提示', messages)
    const parsed = parsePromptTranscript(blocks)
    expect(parsed.system).toBe('系统提示')
    expect(parsed.entries.map((entry) => entry.role)).toEqual(['user', 'tool', 'user'])
    expect(parsed.entries[0]?.content).toEqual([{ type: 'text', text: '第一问' }])
  })

  it('首次聊天（只有用户消息与注入块）不写历史说明，注入块也不会被误判成它', () => {
    const blocks = buildPromptContent(undefined, [user('问'), injected('时间快照', 'time-context')])
    const texts = textOf(blocks)
    expect(texts.some((text) => text.includes(TOOL_POLICY_TEXT))).toBe(true)
    expect(texts.filter((text) => text.startsWith(HISTORY_OPEN))).toHaveLength(0)
    expect(texts.filter((text) => text.startsWith('<dsh-current-request>'))).toHaveLength(1)
  })

  it('历史里真有 assistant / tool 轨迹时才写历史说明', () => {
    const blocks = buildPromptContent(undefined, [
      user('问'),
      createToolResultMessage({ callId: ToolCallId('call-a'), content: [{ type: 'text', text: '结果' }], isError: false }),
    ])
    const texts = textOf(blocks)
    expect(texts.filter((text) => text.startsWith(HISTORY_OPEN))).toHaveLength(1)
  })
})

describe('前序对话判定', () => {
  it('用户消息与注入块都不算前序对话；assistant / tool 才算', () => {
    expect(hasPriorConversation([user('问'), injected('快照', 'time-context')])).toBe(false)
    expect(hasPriorConversation([
      user('问'),
      createToolResultMessage({ callId: ToolCallId('call-a'), content: [{ type: 'text', text: '结果' }], isError: false }),
    ])).toBe(true)
    expect(hasPriorConversation([createAssistantMessage({ content: [{ type: 'text', text: '答' }], source: { provider: 'test', model: 'test' } })])).toBe(true)
  })
})

describe('取不到用户请求的情形', () => {
  it('只有工具结果时没有当前请求块，但保留历史说明', () => {
    const messages: RequestMessage[] = [
      createToolResultMessage({ callId: ToolCallId('call-a'), content: [{ type: 'text', text: '结果' }], isError: false }),
    ]
    expect(currentRequestBlock(messages)).toBeUndefined()
    const texts = textOf(buildPromptContent(undefined, messages))
    expect(texts.some((text) => text.startsWith(HISTORY_OPEN))).toBe(true)
    expect(texts.some((text) => text.startsWith('<dsh-current-request>'))).toBe(false)
  })

  it('消息为空时不产生历史说明与当前请求块', () => {
    const texts = textOf(buildPromptContent(undefined, []))
    expect(texts.some((text) => text.startsWith(HISTORY_OPEN))).toBe(false)
    expect(texts.some((text) => text.startsWith('<dsh-current-request>'))).toBe(false)
  })

  it('一次性用户输入（无 source）按当前请求处理', () => {
    const oneShot = { role: 'user', content: [{ type: 'text', text: '一次性输入' }] } as unknown as RequestMessage
    expect(latestUserRequest([oneShot])).toBe(oneShot)
    expect(textOf(buildPromptContent(undefined, [oneShot])).at(-1)).toContain('一次性输入')
  })

  it('图片请求在强调块里注明附件位置，不重复发送字节', () => {
    const imageMessage = createUserMessage({
      content: [{ type: 'image', attachment: { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as unknown as ImageAttachmentRef }],
      source: { kind: 'user' },
    })
    const current = currentRequestBlock([imageMessage])
    expect(current?.type).toBe('text')
    expect(current?.type === 'text' ? current.text : '').toContain('附带图片')
  })

  it('有界历史重放：保留最近消息、按预算截断且保序、至少留最后一条', () => {
    const messages: RequestMessage[] = [
      user('旧消息 1'),
      createAssistantMessage({ content: [{ type: 'text', text: '旧回复 1' }], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } }),
      user('旧消息 2'),
      createAssistantMessage({ content: [{ type: 'text', text: '旧回复 2' }], source: { provider: 'antigravity-acp', model: 'gemini-4-neon' } }),
      user('最新问题'),
    ]
    // 预算充足：全部保留且顺序不变。
    expect(boundedHistory(messages, 1_000_000).map((m) => m.role)).toEqual(messages.map((m) => m.role))
    // 预算很小：至少保留最后一条（最新用户请求），更早的整条省略。
    const tiny = boundedHistory(messages, 10)
    expect(tiny.length).toBeGreaterThanOrEqual(1)
    expect(tiny[tiny.length - 1]).toBe(messages[messages.length - 1])
    // 中等预算：保留的必须是原历史的连续尾部（不做空洞裁剪、不打乱顺序）。
    const medium = boundedHistory(messages, 300)
    expect(medium.length).toBeGreaterThanOrEqual(1)
    expect(medium).toEqual(messages.slice(messages.length - medium.length))
    // 空输入直接返回空。
    expect(boundedHistory([], 100)).toEqual([])
  })
})
