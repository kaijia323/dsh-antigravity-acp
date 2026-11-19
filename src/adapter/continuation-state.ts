import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * 一条消息的稳定身份。
 *
 * DSH 在消息创建时生成一次 `randomUUID()`，写进会话日志，之后每次派生历史都
 * 原样返回同一个对象（`dsh-session/src/surface.ts` 的 `case 'user/message':
 * return event.data`），跨进程重启也不变。
 *
 * 因此**身份由 id 确定，内容由 content 确定**——两者分开比较，就不需要再猜
 * 「这条消息是模型输出还是宿主注入」。
 */
export function messageId(message: RequestMessage): string {
  const id = (message as { readonly id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

/** 读消息的 `source.kind`；无 source 时返回 undefined。 */
export function messageSourceKind(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  return source && typeof source.kind === 'string' ? source.kind : undefined
}

/** 读消息的 `source.form`；无 source 时返回 undefined。 */
export function messageSourceForm(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly form?: unknown } }).source
  return source && typeof source.form === 'string' ? source.form : undefined
}

/**
 * 可以重复获取的大块宿主上下文：快照 / 目录 / 指令 / 召回材料。
 *
 * 工具续轮里这些块不必再塞进工具结果：它们不是一次性事件，下一回合仍能按
 * id 与内容重新出现。其余未知 form 一律按「需要投递」处理——漏掉一条一次性
 * 通知（子代理完成、后台任务完成、用户插话）的代价远高于多带一段文本。
 */
export const REPEATED_CONTEXT_FORMS: ReadonlySet<string> = new Set(['snapshot', 'catalog', 'instructions', 'recall'])

/** 单条尾部消息投递时的字符上限；超出部分截断，避免把工具结果撑爆。 */
const TAIL_DELIVERY_MESSAGE_MAX_CHARS = 8_000
/** 一轮续轮投递的尾部文本总上限。 */
const TAIL_DELIVERY_TOTAL_MAX_CHARS = 16_000

/** 取一条请求消息里可投递给模型的纯文本。 */
function requestMessageText(message: RequestMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片内容已省略]')
  }
  return parts.join('\n').trim()
}

/**
 * 把「宿主在工具续轮期间追加的 user 消息」序列化进工具结果。
 *
 * 续轮仍处于同一个 ACP prompt 内：不能再发第二条 prompt，ACP v1 也没有单独
 * 追加 user 内容的通道；工具结果内容是此时唯一能回传文本的入口。一次性通知
 * （子代理完成 / 后台任务完成）与用户插话都靠它送达，否则 agent 在续轮里永远
 * 看不到它们；判定失败则会丢弃 ACP 会话并让整轮不可恢复（真机 2026-11-19）。
 *
 * 只跳过可重复的大块上下文（快照 / 目录 / 指令 / 召回）：它们在后续回合仍会
 * 以相同 id 重新出现，不必塞进工具结果。未知 form 一律投递（宁可多带，不可漏）。
 */
export function tailDeliveryNote(messages: readonly RequestMessage[]): string | undefined {
  const parts: string[] = []
  let total = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    const form = messageSourceForm(message)
    if (form !== undefined && REPEATED_CONTEXT_FORMS.has(form)) continue
    const text = requestMessageText(message)
    if (text === '') continue
    const capped = text.length > TAIL_DELIVERY_MESSAGE_MAX_CHARS
      ? text.slice(0, TAIL_DELIVERY_MESSAGE_MAX_CHARS) + '…（已截断）'
      : text
    if (total + capped.length > TAIL_DELIVERY_TOTAL_MAX_CHARS) break
    total += capped.length
    parts.push(capped)
  }
  if (parts.length === 0) return undefined
  return [
    '',
    '[DSH 在你处理工具期间追加的消息（宿主通知或用户插话，未中断当前回合；请在本回合内一并考虑）]',
    ...parts.map((text, index) => (index + 1) + '. ' + text),
  ].join('\n')
}

/** Only model-visible values participate here; identity is compared separately by id. */
export function messageValue(message: RequestMessage): unknown {
  return message.role === 'tool'
    ? { role: message.role, content: message.content, toolCallId: message.toolCallId, isError: message.isError === true }
    : { role: message.role, content: message.content }
}

/** Deterministic JSON: object keys sorted, so fingerprints survive property order. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  })
}

function configuration(options: GenerateOptions): string {
  return stable({
    provider: options.provider, model: options.model, effort: options.reasoningEffort?.toString(),
    system: options.system ?? '',
    tools: [...(options.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  })
}

interface HistoryEntry {
  id: string
  value: string
}

/**
 * 续轮完整性：历史必须是「我们实际发出去的那份」的纯追加。
 *
 * 判定不再依赖消息来源分类，只依赖两条硬事实：
 *
 * 1. **id**：已经发出去的消息带着确定的 id，之后每次请求都会原样出现；
 * 2. **id 是否见过**：一条 `user` 角色、id 又不在已发送集合里的消息，只可能是
 *    本次请求新增的内容——宿主在请求生成时追加的上下文（`time-context`、
 *    `runtime-context`、技能目录、后台任务通知……）或用户在回合中途的插话
 *    （DSH `busyEnter: steer`）。这些消息的位置与数量都不由模型决定，因此
 *    既不参与前缀比较，也不阻挡续轮；其中一次性通知与用户插话由适配器在
 *    工具结果里投递给 agent（见 `trailingUnsentUserMessages`）。
 *
 * 这样就不需要枚举 DSH 的来源类型——新增任何来源都会自动落入「id 没见过」
 * 这一条，不需要改代码。只有**出现在历史中间**的新 user 消息仍会破坏前缀
 * （那是历史被篡改，不是尾部追加）。
 */
export class ContinuationState {
  readonly #configuration: string
  readonly #history: HistoryEntry[]
  readonly #knownIds: Set<string>
  readonly #emitted: ContentBlock[] = []

  constructor(options: GenerateOptions) {
    this.#configuration = configuration(options)
    this.#history = options.messages.map((message) => ({
      id: messageId(message),
      value: stable(messageValue(message)),
    }))
    this.#knownIds = new Set(this.#history.map((entry) => entry.id))
  }

  emitted(block: ContentBlock): void { this.#emitted.push(structuredClone(block)) }

  /**
   * 一条 user 消息的 id 从未发出去过。
   *
   * 已发送的消息无论被重建多少次 id 都不变，所以「没见过」只可能是本次请求
   * 新增的内容；区分宿主上下文与用户插话交给调用方（是否 `kind === 'user'`）。
   */
  isUnsentUser(message: RequestMessage): boolean {
    return message.role === 'user' && !this.#knownIds.has(messageId(message))
  }

  /**
   * 这条消息是否是宿主在请求生成时追加的上下文（而不是用户插话）。
   *
   * 判定只看两件事：user 角色 + id 从未发出去过（宿主上下文），且
   * `source.kind !== 'user'`（真实用户输入的明确标记）。刻意不枚举注入来源：
   * DSH 的注入来源随版本和插件增长，枚举一定会漏。
   */
  isHostContext(message: RequestMessage): boolean {
    return this.isUnsentUser(message) && messageSourceKind(message) !== 'user'
  }

  /**
   * 去掉尾部全部「尚未发出」的 user 消息。
   *
   * 既包括宿主追加上下文，也包括用户在回合中途的插话（steer）。它们都追加在
   * 工具结果之后，不能因为排在末尾就让续轮判定失败——那会丢弃 ACP 会话并
   * 让整轮进入不可恢复状态（真机 2026-11-19 15:11 复现）。
   */
  trimTrailingUnsentUser(messages: readonly RequestMessage[]): readonly RequestMessage[] {
    let end = messages.length
    while (end > 0 && this.isUnsentUser(messages[end - 1]!)) end -= 1
    return end === messages.length ? messages : messages.slice(0, end)
  }

  /** 取尾部尚未发出的 user 消息（保持原顺序）；没有则空数组。 */
  trailingUnsentUserMessages(messages: readonly RequestMessage[]): RequestMessage[] {
    const kept = this.trimTrailingUnsentUser(messages)
    return kept.length === messages.length ? [] : [...messages.slice(kept.length)]
  }

  accepts(options: GenerateOptions, resultCount: number): boolean {
    if (configuration(options) !== this.#configuration) return false
    // 先去掉尾部未发送的 user 消息，再取固定长度的前缀；顺序不能反，否则会把
    // 工具结果算丢。
    const current = this.trimTrailingUnsentUser(options.messages)
    const prefix = current.slice(0, -resultCount)
    if (prefix.length < this.#history.length) return false
    for (const [index, entry] of this.#history.entries()) {
      const message = prefix[index]
      if (message === undefined) return false
      if (messageId(message) !== entry.id) return false
      if (stable(messageValue(message)) !== entry.value) return false
    }
    // 已发送前缀之后、工具结果之前的空隙里可能还夹着宿主上下文（工具循环中途
    // 到期的那种）。它们同样按「user 角色 + id 没见过」识别，不参与「只能是
    // assistant」的判定。真实用户消息插在这里仍然必须拒绝。
    const appended = prefix.slice(this.#history.length).filter((message) => !this.isHostContext(message))
    if (appended.some((message) => message.role !== 'assistant')) return false
    return stable(appended.flatMap((message) => [...message.content])) === stable(this.#emitted)
  }
}
