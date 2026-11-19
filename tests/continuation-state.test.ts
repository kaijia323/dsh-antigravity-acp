import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { ContinuationState, tailDeliveryNote } from '../src/adapter/continuation-state.js'

const call: ToolCallBlock = { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{"path":"a"}' }
function initial(): GenerateOptions {
  return {
    provider: 'antigravity-acp', model: 'gemini', system: 'obey policy',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'read a' }], source: { kind: 'user' } })],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }
}
function continuation(base: GenerateOptions): GenerateOptions {
  return { ...base, messages: [
    ...base.messages,
    createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
    createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
  ] }
}

describe('continuation request integrity', () => {
  it('accepts unchanged context plus exactly the emitted blocks and tool results', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    expect(state.accepts(continuation(base), 1)).toBe(true)
  })
  it.each(['model', 'reasoning', 'system', 'history', 'inserted-system', 'schema', 'assistant'] as const)('rejects changed %s', (kind) => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    if (kind === 'model') next.model = 'other'
    if (kind === 'reasoning') next.reasoningEffort = ReasoningEffortId('high')
    if (kind === 'system') next.system = 'new policy'
    if (kind === 'history') next.messages[0] = createUserMessage({ content: [{ type: 'text', text: 'changed' }], source: { kind: 'user' } })
    if (kind === 'inserted-system') next.messages.splice(1, 0, createSystemMessage('new policy'))
    if (kind === 'schema') next.tools = [{ ...next.tools![0]!, parameters: { type: 'object' } }]
    if (kind === 'assistant') next.messages[1] = createAssistantMessage({ content: [{ ...call, arguments: '{"path":"other"}' }], source: { provider: base.provider, model: base.model } })
    expect(state.accepts(next, 1)).toBe(false)
  })
  it('rejects edits to previously delivered tool results during later batches', () => {
    const base = continuation(initial())
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    next.messages[2] = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'rewritten' }], isError: false })
    expect(state.accepts(next, 1)).toBe(false)
  })
})

describe('注入块不参与续轮前缀比较', () => {
  function injected(text: string): RequestMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] },
    } as never) as RequestMessage
  }

  it('尾部注入块仍可续轮（真机 AGY_SESSION_UNRECOVERABLE 的离线锁）', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    // 注入块落在工具结果之后：DSH pre-step 的真实位置。
    next.messages = [...next.messages, injected('Time sampled while preparing turn 2, step 10: ...')]
    // resultCount 只数尾部真实 tool 结果，不看被注入块挡住的那些。
    expect(state.accepts(next, 1)).toBe(true)
  })

  it('历史中间的注入块同样不破坏前缀', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    next.messages = [
      next.messages[0]!,
      injected('中间快照'),
      ...next.messages.slice(1),
    ]
    expect(state.accepts(next, 1)).toBe(true)
  })

  it('真实用户消息插在历史中间仍然破坏前缀（注入豁免不能变成任意篡改）', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    next.messages = [
      next.messages[0]!,
      createUserMessage({ content: [{ type: 'text', text: '插入的用户消息' }], source: { kind: 'user' } }),
      ...next.messages.slice(1),
    ]
    expect(state.accepts(next, 1)).toBe(false)
  })

  it('注入块被剔除后不影响「实际交付块」的判定', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    // 把**交付的块**本身换掉必须拒绝：注入豁免不能掩盖真实输出被改。
    const tampered = continuation(base)
    tampered.messages[1] = createAssistantMessage({
      content: [{ ...call, arguments: '{"path":"other"}' }],
      source: { provider: base.provider, model: base.model },
    })
    expect(state.accepts(tampered, 1)).toBe(false)
  })
})

describe('注入块剔除必须两侧对称', () => {
  function injected(text: string): RequestMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] },
    } as never) as RequestMessage
  }

  it('构造时历史里已有注入块 → 仍能续轮（2026-11-19 真机回归）', () => {
    // 真机首轮请求就带 time-context；若构造侧不剔除，history 比 prefix 多一条，
    // 索引错位导致每次工具续轮都失败。
    const base: GenerateOptions = {
      ...initial(),
      messages: [
        ...initial().messages,
        injected('Time sampled while preparing turn 1, step 1: ...'),
      ],
    }
    const state = new ContinuationState(base)
    state.emitted(call)
    const next: GenerateOptions = { ...base, messages: [
      ...base.messages,
      createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
      createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
    ] }
    expect(state.accepts(next, 1)).toBe(true)
  })

  it('两侧都剔除后，真实内容变化仍被拒绝', () => {
    const base: GenerateOptions = {
      ...initial(),
      messages: [...initial().messages, injected('快照 A')],
    }
    const state = new ContinuationState(base)
    state.emitted(call)
    // 把真实用户消息改掉（注入块之外的内容）必须仍然拒绝。
    const next: GenerateOptions = { ...base, messages: [
      createUserMessage({ content: [{ type: 'text', text: '改过的输入' }], source: { kind: 'user' } }),
      injected('快照 A'),
      createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
      createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
    ] }
    expect(state.accepts(next, 1)).toBe(false)
  })
})

describe('宿主上下文按 id 识别，不再按来源类型', () => {
  /** 造一条「宿主在请求生成时追加」的消息：user 角色 + 全新 id。 */
  function hostContext(text: string, kind = 'whichever-new-kind'): RequestMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind, form: 'notice' },
    } as never) as RequestMessage
  }

  it('尾部任意来源的宿主上下文都不阻塞续轮（不枚举 kind）', () => {
    for (const kind of ['time-context', 'tool-jobs', 'plan-mode', 'goal', 'brand-new-kind-2027']) {
      const base = initial()
      const state = new ContinuationState(base)
      state.emitted(call)
      const next = continuation(base)
      next.messages = [...next.messages, hostContext('宿主追加', kind)]
      expect(state.accepts(next, 1), `kind=${kind} 应放行`).toBe(true)
    }
  })

  it('工具循环中途插入的宿主上下文同样被放行（0.2.2 的原始事故）', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    // 插在 assistant 与 tool 结果之间：工具结果不再紧邻尾部。
    next.messages = [
      next.messages[0]!, next.messages[1]!, hostContext('中途快照'),
      ...next.messages.slice(2),
    ]
    expect(state.accepts(next, 1)).toBe(true)
  })

  it('工具结果之后的真实用户插话（steer）不再破坏续轮，并能被单独取出投递', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    const steer = createUserMessage({ content: [{ type: 'text', text: '用户插话' }], source: { kind: 'user' } })
    next.messages = [...next.messages, steer]
    expect(state.accepts(next, 1)).toBe(true)
    expect(state.trailingUnsentUserMessages(next.messages)).toEqual([steer])
  })

  it('已发送的历史被改写（同 id 不同内容）必须拒绝', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    const original = next.messages[0]!
    next.messages = [
      { ...original, content: [{ type: 'text', text: '改过的内容' }] } as RequestMessage,
      ...next.messages.slice(1),
    ]
    expect(state.accepts(next, 1)).toBe(false)
  })
})

describe('尾部未发送消息的投递（宿主通知 / 用户插话）', () => {
  /** 造一条指定 kind/form 的 user 消息（宿主在请求生成时追加）。 */
  function hostContext(text: string, kind: string, form: string): RequestMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind, form },
    } as never) as RequestMessage
  }

  it('多条尾部消息按原顺序取出；assistant/tool 不混入', () => {
    const base = initial()
    const state = new ContinuationState(base)
    const next = continuation(base)
    const notice = hostContext('后台任务完成', 'tool-jobs', 'notice')
    const steer = createUserMessage({ content: [{ type: 'text', text: '先看这个' }], source: { kind: 'user' } })
    const all = [...next.messages, notice, steer]
    expect(state.trimTrailingUnsentUser(all)).toEqual(next.messages)
    expect(state.trailingUnsentUserMessages(all)).toEqual([notice, steer])
  })

  it('tailDeliveryNote 投递一次性通知与用户插话，跳过可重复的大块上下文', () => {
    const notice = hostContext('Background subagent x finished: OK', 'subagent-settled', 'notice')
    const steer = createUserMessage({ content: [{ type: 'text', text: '先做 UI' }], source: { kind: 'user' } })
    const snapshot = hostContext('Time sampled ...', 'time-context', 'snapshot')
    const note = tailDeliveryNote([snapshot, notice, steer])
    expect(note).toBeDefined()
    expect(note).toContain('Background subagent x finished: OK')
    expect(note).toContain('先做 UI')
    expect(note).not.toContain('Time sampled')
  })

  it('没有可投递内容时返回 undefined', () => {
    const snapshot = hostContext('Time sampled ...', 'time-context', 'snapshot')
    expect(tailDeliveryNote([snapshot])).toBeUndefined()
  })
})
