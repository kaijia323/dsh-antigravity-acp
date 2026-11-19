/**
 * Antigravity ACP 的 LlmAdapter 实现。
 *
 * 形态：官方 ACP server（Gemini 主模型）走 stdio，工具留在 DSH 侧，经插件
 * 进程内的私有 loopback MCP 桥暴露给 agent（见 ../bridge/mcp-bridge.ts）。
 *
 * DSH 是历史权威：只有输入前缀与上轮实际交付输出一致才复用会话；失效时丢弃
 * 内存记录但**保留磁盘映射**，交给 `session/resume` 接回（不重放历史）。模型/思考
 * 强度变化就地 `session/set_config_option`，不重建会话。工具结果在同一个 ACP prompt
 * 内经 MCP 回填。可选磁盘映射只保存 ID、计数与指纹，不存消息正文。
 */
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AnyRequest, McpServer as AcpMcpServer, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk'
import type { AgentLink, AgentLinkHandlers } from '../protocol/agent-link.js'
import { BRIDGE_MCP_SERVER_NAME, McpToolBridge } from '../bridge/mcp-bridge.js'
import type { BridgeToolResult } from '../bridge/mcp-bridge.js'
import {
  AGY_REASONING_EFFORTS,
  AGY_REASONING_EFFORT_NAMES,
  DEFAULT_AGY_REASONING_EFFORT,
  foldAgyModelFamilies,
  modelFamilyId,
  routeTieredModelId,
  registerTierSuffix,
  tierForModelId,
} from '../runtime/agy-cli.js'
import type { AgyModelTier } from '../runtime/agy-cli.js'
import { findModelSelector, findThoughtLevelSelector, toModelCatalog } from './model-catalog.js'
import type { ModelSelector, ThoughtLevelSelector } from './model-catalog.js'
import type { CachedCatalog, CachedThoughtLevel } from '../runtime/catalog-cache.js'
import { applyModelSettings, modelDisplayName, modelSettingFor, normalizeModelSettings, resolveModelTarget } from './model-settings.js'
import type { ModelSetting } from './model-settings.js'
import { buildPromptDeltaWithImages, buildPromptWithImages, buildToolResultContent } from './image-content.js'
import { boundedHistory } from './prompt-transcript.js'
import type { ImageReader } from './image-content.js'
import { AGY_TURN_ERROR, PromptTurn } from './prompt-turn.js'
import type { AcpLifecycle } from '../runtime/lifecycle.js'
import { ContinuationState, tailDeliveryNote } from './continuation-state.js'
import { incrementalMessages, outputHash, outputMatches, prefixHash, prefixMatches, reusableSessionKey, routeFingerprint } from './session-reuse.js'
import { SessionMapStore } from '../runtime/session-map.js'
import type { SessionMapEntry } from '../runtime/session-map.js'
import type { ModelOverride } from '../settings.js'

/** DSH 侧 provider 标识符；与 cordis.patch.yml 的 id 及文档保持一致。 */
export const AGY_PROVIDER_ID = 'antigravity-acp'

/**
 * 旧会话里可能留下的占位路由 id（`server-default`）。
 *
 * 现在**不再广告**这条目录项：未观测到官方目录时目录可以为空（见
 * docs/reference.md），真实条目只在观测到 ACP 会话或 CLI 清单后出现。保留该
 * 常量只为了识别历史会话/旧配置里的这个 id：命中且没有显式映射时不调用
 * session/set_config_option，沿用官方会话默认模型。
 */
export const AGY_PLACEHOLDER_MODEL_ID = 'server-default'

/** 本 adapter 的其余原创错误码（AGY_* 体系）。 */
export const AGY_ADAPTER_ERROR = {
  /** 同一时刻已有活跃回合，且当前请求不是它的续轮。 */
  BUSY: 'AGY_BUSY',
  /** 回合需要一个模型选择器，但 ACP 会话未声明任何 model 类 configOption。 */
  NO_MODEL_SELECTOR: 'AGY_NO_MODEL_SELECTOR',
  /** agent 应答选模却没有确认请求的型号，不能静默使用其他模型。 */
  MODEL_SELECTION_MISMATCH: 'AGY_MODEL_SELECTION_MISMATCH',
  /** 历史无法接上（会话映射失效 / agent 不支持 resume）：按约定不回退重放。 */
  SESSION_UNRECOVERABLE: 'AGY_SESSION_UNRECOVERABLE',
  /** 请求的思考档位不在 agent 声明的选项里：按约定不做就近收敛。 */
  EFFORT_UNSUPPORTED: 'AGY_EFFORT_UNSUPPORTED',
} as const

/** MCP 桥与回合的可调参数（由 index.ts 从插件配置注入）。 */
export interface AntigravityAcpAdapterOptions {
  lifecycle?: AcpLifecycle
  /**
   * 惰性启动工厂：返回完成 initialize + authenticate 的 AgentLink。传入的
   * handlers 必须在整个 adapter 生命周期内保持**同一对象**——index.ts 会把
   * 首个 handler 集合固化到被缓存的 AgentLink 上，后续回合只更换其内部状态。
   */
  getLink: (handlers: AgentLinkHandlers, signal?: AbortSignal, purpose?: 'warmup') => Promise<AgentLink>
  /** 回收指定连接及其受管子进程；完成前禁止开启下一个回合。 */
  recycleLink: (link: AgentLink) => Promise<void>
  /** 登记桥的关闭钩子（index.ts 把它挂到 ActiveAcpRuntime.bridgeTeardown）。 */
  registerBridgeTeardown: (teardown: () => Promise<void>) => void
  /** session/prompt 等待上限（毫秒）。 */
  promptTimeoutMs?: number
  /**
   * session/new 与 session/resume 的请求上限（毫秒）。
   *
   * 与通用 requestTimeoutMs（默认 30 秒）分开：官方 agent 进程冷启动、同账号
   * 多 worker 并发时，30 秒内完成会话创建并不罕见（真机 2026-11-19 子代理
   * `session/new` 超时）。默认 120 秒。
   */
  sessionTimeoutMs?: number
  /** 并发 MCP park 的聚合窗口（毫秒）。 */
  parkSettleMs?: number
  /** session/new 使用的工作目录；缺省为进程 cwd。 */
  cwd?: string
  /**
   * 会话模式（agent 声明的 mode id，例如 `plan`）。留空沿用 agent 默认。
   * 只作用于新建/恢复的会话；未在 agent 的 availableModes 里声明时不发送。
   */
  agentMode?: string
  /**
   * 按模型 ID 的目录设置：显示开关、显示名与官方模型 ID 映射。
   * 只作用于目录中已存在的条目，不新增自造模型。
   */
  modelOverrides?: Record<string, ModelOverride>
  /**
   * 冷启动目录读取（磁盘缓存）。返回 undefined 表示没有可用缓存；**不得**抛错。
   * 元数据方法不得触网，因此这里只能读本地文件。
   */
  loadCachedCatalog?: () => Promise<CachedCatalog | undefined>
  /** 观测到真实目录后的落盘回调；失败由实现方自行吞掉。 */
  saveCatalog?: (catalog: CachedCatalog) => Promise<void> | void
  /** Metadata only, for sharing catalog/context observations across isolated workers. */
  onMetadataChanged?: (metadata: AdapterMetadata) => void
  readImage?: ImageReader
  canReadImages?: () => boolean
  /**
   * 官方 CLI 模型清单（`agy models` 的只读取数，2026-10-16 授权仅限只读取数
   * 用途）。用于补齐会话观测之外的官方型号；失败由 adapter 吞掉。
   */
  loadCliCatalog?: () => Promise<readonly { id: string; name: string }[]>
  /**
   * 宿主日志（index.ts 接 `ctx.logger`）。仅用于**自诊断**：模型路由决策与
   * `session/set_config_option` 失败原因。缺省时不产任何日志。
   */
  log?: AdapterLog
  /**
   * 跨进程恢复 ACP 会话（默认 true）：重启后若存在会话映射，用 `session/resume`
   * 接回原会话而不是从零重建。映射由 loadSessionMap / saveSessionMap 提供。
   */
  resumeSessions?: boolean
  /** 取消后等待 agent 确认停止的上限（毫秒）；0 表示不等待、立即回收，绝不复用未确认连接。 */
  cancelGraceMs?: number
  /** 保留进程的最长空闲时间（毫秒），超时回收；0 表示不设上限。 */
  idleRecycleMs?: number
  /**
   * 会话接不上时是否允许有界历史重放兜底（默认 true）。
   *
   * 不开就一直报 `AGY_SESSION_UNRECOVERABLE`（旧行为）；开启后用
   * `boundedHistory()` 把最近若干消息重放给新建 ACP 会话，对话可以继续，
   * 代价是更早的历史对模型不可见、且会消耗一次输入 token。
   */
  replayFallback?: boolean
  /** 重放兜底的历史预算（字符数，默认 120000）。 */
  replayMaxChars?: number
  /**
   * 目录未报告上下文容量时的兜底窗口（tokens，默认 1048576；0 表示不填）。
   * 没有它，DSH 在切换到未观测容量的模型时会报 MODEL_SWITCH_COMPACTION_FAILED。
   */
  defaultContextWindow?: number
  /** 所有 worker 共享的映射存储（含键所有权与串行提交）。 */
  sessionStore?: SessionMapStore
  /** Capture live preferences only between ACP turns, never during tool continuation. */
  readSettings?: () => Pick<AntigravityAcpAdapterOptions, 'modelOverrides' | 'resumeSessions' | 'cancelGraceMs' | 'idleRecycleMs' | 'sessionStore' | 'replayFallback' | 'replayMaxChars' | 'defaultContextWindow'>
  /** 独立 adapter 的兼容读取回调；连接池必须改用共享 sessionStore。 */
  loadSessionMap?: () => Promise<Record<string, SessionMapEntry>>
  /** 保存 ACP 会话映射；失败由实现方吞掉。 */
  saveSessionMap?: (entries: Record<string, SessionMapEntry>) => Promise<void> | void
}

/** 适配器可用的最小日志面（与 cordis 的 `ctx.logger` 结构兼容）。 */
export interface AdapterLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

/** 目录缓存条目（只含模型元数据，不含任何凭据）。 */
export interface CachedModel {
  id: string
  name: string
  description?: string
  /** 实测上下文容量（usage_update.size）；官方目录不报告，故可缺省。 */
  contextWindow?: number
}

export interface AdapterMetadata {
  catalog: CachedModel[]
  contextWindows: Array<[string, number]>
  /** 区分真实 ACP 档位观测与 CLI 家族兜底，避免弱快照覆盖完整目录。 */
  catalogSource: 'acp' | 'fallback'
  imageSupported?: boolean
  /** 观测到的思考强度选择器；跨 worker 共享，菜单在没建过会话的 worker 上也一致。 */
  thoughtLevel?: CachedThoughtLevel
}

/**
 * 一个可复用的 ACP 会话。
 *
 * `sentCount` / `sentHash` 记录「哪些 DSH 消息已经在这个 ACP 会话里体现过」：
 * 新轮只发送其后的新增消息；历史被压缩、回退或编辑导致前缀不再匹配时，
 * 记录作废并受控重建。
 */
interface ReusedSession {
  key: string
  sessionId: string
  link: AgentLink
  sentCount: number
  sentHash: string
  route: string
  /** 上一步实际交付输出的指纹；尚未完成的回合不能恢复。 */
  outputHash?: string
  /** 该会话是否注册过 MCP 工具；只有这类会话依赖桥的 token 归属。 */
  usesTools: boolean
  /** 上一轮被用户取消（没有交付输出）：允许下一轮直接续，不要求输出指纹匹配。 */
  cancelled?: boolean
}

/*
 * 关于失败重试：**刻意不 override `providerRetryPolicy`**。
 *
 * 宿主若消费该策略（可选的 dsh-llm-retry 插件）在 failed-step 上会**整步重放**
 * `stream()`。而本 adapter 的每一类失败都不可安全重放：
 * - 握手失败 / 链路断开 → 重放等于重新 spawn 一条官方进程；
 * - 认证超时（`AGY_AUTH_TIMEOUT`）→ 重放等于重新弹一次 Google 登录；
 * - `session/prompt` 超时（`AGY_REQUEST_TIMEOUT`）→ 官方 agent 可能已经产出内容或
 *   已发起工具调用，重放会新建会话并重放全部历史，造成重复内容与重复工具调用。
 *
 * 默认词表（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）
 * 本 adapter 一个都不会抛：宿主在 `providerRetryPolicy() ?? resolveRetryPolicy(undefined)`
 * 处装上的默认政策因此对本 provider 不生效。这里的前提是「我们抛的码一律带
 * `AGY_` 前缀」，该前提由 `tests/acp-adapter.test.ts` 的「失败码与宿主默认重试
 * 词表无交集」用例锁住——若将来 dsh-llm 把某个 AGY_ 码加进默认词表，测试会红。
 * 真正需要重试语义时，应针对单类失败单独引入可证明幂等的路径，而不是整步重放。
 */

/** 有界历史重放兜底的默认字符预算。 */
const DEFAULT_REPLAY_MAX_CHARS = 120_000
/** 目录未报告容量时的默认上下文窗口（tokens）。 */
const DEFAULT_CONTEXT_WINDOW = 1_048_576
/** Claude 家族的保守上限：目录不报告容量时按 200k 处理，避免高估导致上游截断。 */
const CLAUDE_CONTEXT_WINDOW = 200_000

/**
 * 目录未报告容量时的兜底上下文窗口。
 *
 * 官方 ACP 目录只给模型 id/名称，真实容量要等 `usage_update` 才能观测到；
 * DSH 在切换模型时要靠它计算压缩目标，缺省会报
 * `MODEL_SWITCH_COMPACTION_FAILED: no context capacity`。这里只做**可配置的
 * 保守默认**（settings.defaultContextWindow），Claude 家族封顶 200k；
 * 配置为 0 时恢复旧行为（不填容量）。
 */
export function fallbackContextWindow(model: string, configured: number): number | undefined {
  if (!Number.isFinite(configured) || configured <= 0) return undefined
  if (/^claude/i.test(model)) return Math.min(configured, CLAUDE_CONTEXT_WINDOW)
  return configured
}
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_SESSION_TIMEOUT_MS = 120_000
const DEFAULT_PARK_SETTLE_MS = 50

export class AntigravityAcpAdapter extends LlmAdapter {
  readonly #lifecycle: AcpLifecycle | undefined
  readonly #getLink: AntigravityAcpAdapterOptions['getLink']
  readonly #recycleLink: AntigravityAcpAdapterOptions['recycleLink']
  #cleanup: Promise<void> = Promise.resolve()
  /**
   * 回收未成功的连接。回收失败（旧进程暂时没退干净）时屏障仍然挡住新回合，但不能
   * 永久中毒：下一轮会对**同一条连接**重试回收，旧进程之后退出了就自动恢复。
   */
  #unrecycledLink: AgentLink | undefined
  readonly #registerBridgeTeardown: AntigravityAcpAdapterOptions['registerBridgeTeardown']
  readonly #promptTimeoutMs: number
  readonly #sessionTimeoutMs: number
  readonly #parkSettleMs: number
  readonly #cwd: string
  /** 配置的会话模式；空串表示沿用 agent 默认。 */
  #agentMode: string
  /** 用户模型设置的只读快照；每次读取设置时整体替换。 */
  #modelSettings: ReadonlyMap<string, ModelSetting> = new Map()
  readonly #readSettings?: AntigravityAcpAdapterOptions['readSettings']
  readonly #loadCachedCatalog?: AntigravityAcpAdapterOptions['loadCachedCatalog']
  readonly #saveCatalog?: AntigravityAcpAdapterOptions['saveCatalog']
  readonly #loadCliCatalog?: AntigravityAcpAdapterOptions['loadCliCatalog']
  readonly #log?: AdapterLog
  readonly #onMetadataChanged?: AntigravityAcpAdapterOptions['onMetadataChanged']
  #resumeSessions: boolean
  #sessionStore?: SessionMapStore
  readonly #sessionOwner = Symbol('acp-worker')
  /** 同一 DSH 对话（普通聊天轮）→ 可复用的 ACP 会话，最多 64 个。 */
  readonly #sessions = new Map<string, ReusedSession>()
  /** >0 时丢弃入站 session/update：恢复会话时可能有迟到的历史回放。 */
  #suppressUpdates = 0
  #cancelGraceMs: number
  #idleRecycleMs: number
  /** 会话接不上时是否允许有界历史重放兜底。 */
  #replayFallback: boolean
  /** 重放兜底的历史预算（字符数）。 */
  #replayMaxChars: number
  /** 目录未报告容量时的兜底上下文窗口（0 表示不填）。 */
  #defaultContextWindow: number
  /** 取消后的确认定时器；agent 先确认停止就取消回收。 */
  #cancelGrace: { timer: ReturnType<typeof setTimeout>; link: AgentLink; turn: PromptTurn; pending: Promise<void>; resolve(): void } | undefined
  /** 保留进程的空闲回收定时器；有新回合就撤销。 */
  #idleRecycle: { timer: ReturnType<typeof setTimeout>; link: AgentLink } | undefined
  #currentLink: AgentLink | undefined
  readonly #ephemeral = new Map<PromptTurn, AgentLink>()
  readonly #sessionCloses = new Set<Promise<void>>()
  #continuationState: ContinuationState | undefined
  readonly #readImage?: ImageReader
  readonly #canReadImages?: () => boolean
  #imageSupported: boolean | undefined
  /** 当前目录来源：ACP 原始档位观测优先于 CLI 家族兜底。 */
  #catalogSource: 'acp' | 'fallback' = 'fallback'
  /** 仅其它 worker 的 CLI 家族目录，不能冒充当前 worker 的 ACP 观测。 */
  #fallbackCatalog: LlmModelInfo[] = []
  /** 官方 CLI 清单的在途读取；完成即释放，底层负责缓存和后台刷新。 */
  #cliCatalog?: Promise<readonly { id: string; name: string }[]>
  /** 家族 → 支持的思考强度档位（由目录折叠得到）。 */
  #familyTiers = new Map<string, ReadonlySet<AgyModelTier>>()
  /** 防止异步 CLI 读取后的旧折叠结果覆盖较新的会话目录。 */
  #catalogFoldGeneration = 0
  /**
   * 最近一次家族折叠的结果（id → 折叠后的条目）。供 `resolveModel` 同步取
   * 显示名：DSH 的路由键是折叠后的家族 id，而 `#catalog` 只含 ACP 的档位 id。
   */
  #foldedFamilies = new Map<string, { id: string; name: string; description?: string }>()
  readonly #bridge: McpToolBridge
  /** 身份稳定的 ACP 事件处理器：AgentLink 只在构造时取一次 handlers。 */
  readonly #handlers: AgentLinkHandlers
  #turn: PromptTurn | undefined
  /** 在首次 await 前占位，避免并发首轮同时通过 #turn 尚未建立的窗口。 */
  #streamActive = false
  #disposed = false
  #turnOwner: Pick<GenerateOptions, 'sessionId' | 'purpose'> | undefined
  readonly #accessWaiters = new Set<() => void>()
  /**
   * 当前 ACP 回合的 park 订阅。生命周期是**回合**而不是单次 `stream` 调用：
   * 首轮以 `finish(tool-calls)` 收尾时 ACP prompt 仍然活着（agent 挂起等回喂），
   * 此时退订会让回喂后 agent 发起的下一批 tools/call 无人接管、MCP 请求永久
   * 挂起（见 #subscribeTurn 的注释）。
   */
  #turnSubscription: { turn: PromptTurn; unsubscribe: () => void } | undefined
  #catalog: LlmModelInfo[] = []
  #modelSelector: ModelSelector | undefined
  /**
   * 观测到的思考强度选择器（ACP 1.5 起是独立 config option，options 随当前
   * 模型变化）。有它时选模只发家族 id，档位单独设置；没有它（旧 agent）才走
   * 「档位编进模型 id」的兼容路由。
   */
  #thoughtLevel: ThoughtLevelSelector | undefined
  /**
   * 已经为某个 ACP 会话确认写入过的档位值；与 `#sessionModelValues` 同理，
   * 只能用于本会话自己的短路判断。
   */
  #sessionThoughtValues = new Map<string, string>()
  /**
   * 已经为某个 ACP 会话确认写入过的模型值。`#modelSelector.currentValue` 是
   * **连接级**缓存（可能来自别的会话、也可能来自上一次 `session/new`），新会话
   * 省略 configOptions 时它不代表本会话的实际模型；用它短路会让新会话静默跑在
   * agent 默认模型上。短路只认本会话自己确认过的值。
   */
  /**
   * system prompt 已通过 `_meta.antigravity.systemPrompt.append` 交给 agent 的会话。
   * 这些会话的 prompt 里不再重复包一个 `<dsh-system>` 文本块。
   */
  readonly #systemViaMeta = new Set<string>()
  #sessionModelValues = new Map<string, string>()
  /**
   * 建立时**自己声明过** model 选择器的会话。只有这种会话才能用
   * `#modelSelector.currentValue` 短路：会话省略 configOptions 时选择器仍留着
   * 上一个会话的值，拿它短路会让新会话跑在 agent 默认模型上。
   */
  #sessionModelDeclared = new Set<string>()
  /** 模型目录的观察来源，用于列表页在真实会话之前就能给出缓存目录。 */
  #catalogObserved = false
  /** 目录缓存的惰性读取结果（只读一次）。 */
  #cacheLoad?: Promise<LlmModelInfo[]>
  /**
   * 各 DSH 路由键（`GenerateOptions.model`）实测到的上下文容量，来自官方
   * `usage_update.size`（ACP 对 `size` 的定义即 total context window size）。
   * 有了它压缩引擎才能量化上下文，而不是每步报「no context capacity」。
   */
  #contextWindows = new Map<string, number>()
  /** 当前 ACP 会话对应的 DSH 路由键，用于把 usage_update 归属到具体模型。 */
  #routeModelId: string | undefined

  constructor(options: AntigravityAcpAdapterOptions) {
    super()
    this.#lifecycle = options.lifecycle
    this.#getLink = options.getLink
    this.#recycleLink = options.recycleLink
    this.#registerBridgeTeardown = options.registerBridgeTeardown
    this.#promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    this.#sessionTimeoutMs = Math.max(1_000, options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS)
    this.#parkSettleMs = options.parkSettleMs ?? DEFAULT_PARK_SETTLE_MS
    this.#cwd = options.cwd ?? process.cwd()
    this.#agentMode = options.agentMode?.trim() ?? ''
    this.#modelSettings = normalizeModelSettings(options.modelOverrides)
    this.#readSettings = options.readSettings
    this.#loadCachedCatalog = options.loadCachedCatalog
    this.#saveCatalog = options.saveCatalog
    this.#loadCliCatalog = options.loadCliCatalog
    this.#log = options.log
    this.#onMetadataChanged = options.onMetadataChanged
    this.#resumeSessions = options.resumeSessions ?? true
    this.#sessionStore = options.sessionStore ?? (options.loadSessionMap && options.saveSessionMap
      ? new SessionMapStore({ load: options.loadSessionMap, save: options.saveSessionMap,
        onError: () => this.#log?.warn('antigravity-acp: 会话映射读写失败，跨进程恢复可能不可用') })
      : undefined)
    this.#cancelGraceMs = Math.max(0, options.cancelGraceMs ?? 30_000)
    this.#idleRecycleMs = Math.max(0, options.idleRecycleMs ?? 0)
    this.#replayFallback = options.replayFallback ?? true
    this.#replayMaxChars = Math.max(1_000, options.replayMaxChars ?? DEFAULT_REPLAY_MAX_CHARS)
    this.#defaultContextWindow = Math.max(0, options.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW)
    this.#readImage = options.readImage
    this.#canReadImages = options.canReadImages
    this.#bridge = new McpToolBridge({
    })
    this.#registerBridgeTeardown(async () => {
      this.#disposed = true
      this.#wakeAccessWaiters()
      if (this.#turn && !this.#isTurnClosed(this.#turn)) this.#turn.abort('adapter 卸载')
      this.#turn?.dispose()
      this.#releaseTurnSubscription()
      this.#dropAllSessions('adapter 卸载')
      for (const [turn, link] of this.#ephemeral) this.#closeSession(link, turn.sessionId)
      this.#ephemeral.clear()
      this.#clearCancelGrace()
      this.#clearIdleRecycle()
      await this.#bridge.close()
      await Promise.allSettled(this.#sessionCloses)
      this.#sessionStore?.release(this.#sessionOwner)
      await this.#sessionStore?.flush()
    })
    this.#handlers = {
      onSessionUpdate: (notification) => {
        // 恢复/迟到回放不是本轮输出，必须丢弃。
        if (this.#disposed || this.#suppressUpdates > 0) return
        this.#observeUsageUpdate(notification)
        return this.#turn?.handleSessionUpdate(notification)
      },
      onRequestPermission: (request) => (!this.#disposed ? this.#turn?.handleRequestPermission(request) : undefined)
        ?? { outcome: { outcome: 'cancelled' } },
      onUnexpectedAgentRequest: (method, request) => this.#handleUnexpectedRequest(method, request),
      onProtocolViolation: (detail) =>
        this.#log?.warn(`antigravity-acp: 已丢弃无法路由的 JSON-RPC 帧（链路与在途请求不受影响）：${detail}`),
    }
  }

  /** 设置页连接不能与正在进行的对话/工具回合竞争同一登录态。 */
  get busy(): boolean {
    return this.#streamActive || Boolean(this.#cancelGrace) || Boolean(this.#turn && !this.#isTurnClosed(this.#turn))
  }

  get streamActive(): boolean { return this.#streamActive }
  get awaitingToolResults(): boolean { return this.#turn?.awaitingToolResults === true }
  ownsRequest(options: Pick<GenerateOptions, 'sessionId' | 'purpose'>): boolean {
    return this.#turnOwner !== undefined && this.#turnOwner.sessionId === options.sessionId && this.#turnOwner.purpose === options.purpose
  }

  exportMetadata(): AdapterMetadata {
    return {
      // 同步原始档位条目：仅传折叠后的家族会丢掉其他 worker 尚未列出的
      // low/high 变体，导致模型名称与 reasoning 档位在不同 worker 间漂移。
      catalog: this.#catalog.length ? this.#catalog.map(({ id, name, description }) => ({ id, name, ...(description === undefined ? {} : { description }) }))
        : [...this.#foldedFamilies.values()].map(({ id, name, description }) => ({ id, name, ...(description === undefined ? {} : { description }) })),
      catalogSource: this.#catalogSource,
      contextWindows: [...this.#contextWindows],
      ...(this.#imageSupported === undefined ? {} : { imageSupported: this.#imageSupported }),
      ...(this.#thoughtLevelSnapshot() === undefined ? {} : { thoughtLevel: this.#thoughtLevelSnapshot() }),
    }
  }

  /** 档位选择器的可缓存快照（只含 agent 声明的档位与当前值，无凭据）。 */
  #thoughtLevelSnapshot(): CachedThoughtLevel | undefined {
    const thought = this.#thoughtLevel
    if (!thought) return undefined
    return {
      configId: thought.configId,
      options: thought.options.map((option) => ({
        value: option.value,
        name: option.name,
        ...(option.description === undefined || option.description === null ? {} : { description: option.description }),
      })),
      ...(thought.currentValue === undefined ? {} : { currentValue: thought.currentValue }),
    }
  }

  /** 用缓存或别的 worker 的快照恢复档位选择器；已有观测时不覆盖。 */
  #restoreThoughtLevel(snapshot: CachedThoughtLevel | undefined): void {
    if (snapshot === undefined || this.#thoughtLevel !== undefined) return
    this.#thoughtLevel = {
      configId: snapshot.configId,
      options: snapshot.options,
      ...(snapshot.currentValue === undefined ? {} : { currentValue: snapshot.currentValue }),
    }
  }

  importMetadata(metadata: AdapterMetadata): void {
    if (metadata.imageSupported !== undefined) this.#imageSupported = metadata.imageSupported
    if (metadata.catalog.length && (this.#catalog.length === 0 || metadata.catalogSource === 'acp' || this.#catalogSource !== 'acp')) {
      ++this.#catalogFoldGeneration
      const catalog = metadata.catalog.map((model) => ({ ...model, provider: AGY_PROVIDER_ID, inputModalities: ['text'] as const }))
      if (metadata.catalogSource === 'fallback') {
        this.#fallbackCatalog = catalog
        this.#catalogSource = 'fallback'
      } else {
        this.#catalog = catalog
        this.#catalogSource = 'acp'
      }
      this.#catalogObserved = true
      this.#cacheLoad = undefined
    }
    this.#restoreThoughtLevel(metadata.thoughtLevel)
    for (const [model, size] of metadata.contextWindows) {
      if (Number.isFinite(size) && size > 0) this.#rememberContextWindow(model, size)
    }
  }

  /**
   * 当前用户模型设置。目录与路由都可能先于下一次预热读取（例如宿主刚保存
   * 设置就刷新目录），因此这里按需从 live 引用取最新值，而不是只用构造时的快照。
   */
  #modelSettingsSnapshot(): ReadonlyMap<string, ModelSetting> {
    const settings = this.#readSettings?.()
    if (settings) this.#modelSettings = normalizeModelSettings(settings.modelOverrides)
    return this.#modelSettings
  }

  #refreshSettings(): void {
    const settings = this.#readSettings?.()
    if (!settings) return
    this.#modelSettings = normalizeModelSettings(settings.modelOverrides)
    this.#resumeSessions = settings.resumeSessions ?? true
    this.#cancelGraceMs = Math.max(0, settings.cancelGraceMs ?? 30_000)
    this.#idleRecycleMs = Math.max(0, settings.idleRecycleMs ?? 0)
    this.#replayFallback = settings.replayFallback ?? true
    this.#replayMaxChars = Math.max(1_000, settings.replayMaxChars ?? DEFAULT_REPLAY_MAX_CHARS)
    this.#defaultContextWindow = Math.max(0, settings.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW)
    if (this.#sessionStore !== settings.sessionStore) this.#sessionStore?.release(this.#sessionOwner)
    this.#sessionStore = settings.sessionStore
  }

  /** Explicit discovery is allowed to authenticate, but never sends a model prompt. */
  async discoverModels(signal?: AbortSignal, interactive = true): Promise<readonly LlmModelInfo[]> {
    if (this.busy) throw new LlmError('ACP 正在处理对话，请在空闲时连接并读取模型目录', AGY_ADAPTER_ERROR.BUSY)
    if (this.#disposed) throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')
    this.#refreshSettings()
    this.#streamActive = true
    this.#clearIdleRecycle()
    let link: AgentLink | undefined
    let discoverySession: string | undefined
    try {
      await withAbort(this.#settleRecycle(true), signal)
      link = await this.#getLink(this.#handlers, signal, interactive ? undefined : 'warmup')
      this.#observeCapabilities(link)
      throwIfAborted(signal)
      const session = await link.newSession({
        cwd: this.#cwd, mcpServers: [],
        _meta: { antigravity: { enabledTools: [], eagerMcpServers: [] } },
      }, { signal })
      discoverySession = session.sessionId
      throwIfAborted(signal)
      if (!findModelSelector(session.configOptions)) throw new LlmError('ACP 会话未提供模型目录', AGY_ADAPTER_ERROR.NO_MODEL_SELECTOR)
      this.observeSessionConfigOptions(session.configOptions)
      return await this.listModels(AGY_PROVIDER_ID)
    } catch (error) {
      if (link) this.#scheduleRecycle(link)
      throw error
    } finally {
      if (link && discoverySession) this.#closeSession(link, discoverySession)
      this.#streamActive = false
      this.#maybeIdle()
      this.#wakeAccessWaiters()
    }
  }

  /** 预热复用聊天的同一组 handlers 和运行时；不建临时会话、不消耗模型请求。 */
  async warmup(signal?: AbortSignal, interactive = false): Promise<void> {
    if (this.#disposed) throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')
    if (this.busy) throw new LlmError('ACP 正在处理对话，无需再次预热', AGY_ADAPTER_ERROR.BUSY)
    this.#refreshSettings()
    this.#streamActive = true
    this.#clearIdleRecycle()
    try {
      await withAbort(this.#settleRecycle(true), signal)
      const link = await this.#getLink(this.#handlers, signal, interactive ? undefined : 'warmup')
      this.#observeCapabilities(link)
    } finally {
      this.#streamActive = false
      this.#maybeIdle()
      this.#wakeAccessWaiters()
    }
  }

  #observeCapabilities(link: AgentLink): void {
    this.#currentLink = link
    const supported = link.initializeResponse?.agentCapabilities?.promptCapabilities?.image === true
    if (supported === this.#imageSupported) return
    this.#imageSupported = supported
    this.#onMetadataChanged?.(this.exportMetadata())
  }

  #imageOptions(signal?: AbortSignal) {
    return { readImage: this.#readImage, supported: this.#imageSupported === true && (this.#canReadImages?.() ?? true), signal }
  }

  #inputModalities(): readonly ('text' | 'image')[] | undefined {
    if (!this.#readImage || !(this.#canReadImages?.() ?? true)) return ['text']
    // 尚未握手时能力是未知，而不是确定只支持文本；准备调用会协商。
    if (this.#imageSupported === undefined) return undefined
    return this.#imageSupported ? ['text', 'image'] : ['text']
  }

  /** 私有 MCP 桥（诊断与测试可见；agent 侧只经 ACP mcpServers 访问它）。 */
  get bridge(): McpToolBridge {
    return this.#bridge
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity (ACP)' }
  }

  /**
   * 模型目录：只读**已观测**的 ACP 会话配置，绝不为了列目录而启动运行时。
   *
   * 依据已安装 SDK 1.4.0 的 d.ts：`InitializeResponse` 只有 protocolVersion /
   * agentCapabilities / authMethods / agentInfo，**没有 configOptions**；模型
   * 选择器出现在 `session/new` 响应、`session/set_config_option` 响应或
   * `session/update(config_option_update)` 里。也就是说，ACP v1 没有任何
   * 「无副作用即可读到模型目录」的方法；而启动运行时必然走
   * `authenticate`（官方进程会自行弹浏览器）。
   *
   * 无真实目录时不再广告首次登录占位项；可在设置页显式连接 ACP 或拉取 CLI
   * 目录。真实目录经 `observeSessionConfigOptions` 观测并缓存。
   */
  /**
   * 本 provider 的模型目录：官方**家族**条目与用户配置的自定义 ID。
   *
   * 家族折叠（2026-10-16 用户指示）：官方把思考强度编码进模型 id
   * （`claude-opus-5-5-{low,medium,high}`），但模型选择只出家族一行，强度由
   * 思考强度菜单路由（见 #applyModelSelection）。会话观测目录与官方 CLI 清单
   * 一并折叠，同 id 去重；被排除的家族（gpt-oss-120b 临近下架）不出现。
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const folded = await this.#foldCatalog(_provider)
    // 用户设置只作用于已观测到的条目：停用的不列入选择器，显示名可覆盖。
    const models = applyModelSettings(this.#modelSettingsSnapshot(), folded.models)
    return [
      ...models.map((model) => ({
        provider: _provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(this.#inputModalities() === undefined ? {} : { inputModalities: this.#inputModalities() }),
      })),
    ]
  }

  /**
   * 折叠家族档位表：会话观测目录（或磁盘缓存）+ 官方 CLI 清单。
   * listModels 与模型路由共用；占位 id 不进家族表。
   */
  async #foldCatalog(provider: string): Promise<{
    models: Array<{ id: string; name: string; description?: string }>
    tiers: Map<string, ReadonlySet<AgyModelTier>>
  }> {
    const generation = ++this.#catalogFoldGeneration
    // 未观测到真实目录时用磁盘缓存兜住选择器空窗。
    // 磁盘缓存来自 ACP 原始档位观测，优先于其它 worker 的 CLI 家族兜底。
    const cached = this.#catalog.length > 0 ? this.#catalog : await this.#cachedModels(provider)
    const source = cached.length > 0 ? cached : [...this.#fallbackCatalog]
    const acpRows = source
      .filter((model) => model.id !== AGY_PLACEHOLDER_MODEL_ID)
      .map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      }))
    const cliRows = await this.#cliRawRows()
    // 已经观测到 ACP 会话声明的模型目录时，只暴露当前账号真正支持的家族，
    // 不把 CLI 清单里当前登录态不可用的型号（如 orchestrator / claude）混进选择器；
    // CLI 行仅用于补齐已支持家族的档位集合（如 Hydrogen 的 xhigh），或冷启动为空时兜底。
    const acpFamilies = acpRows.length > 0
      ? new Set(acpRows.map((row) => modelFamilyId(row.id)))
      : undefined
    const filteredCliRows = acpFamilies === undefined
      ? cliRows
      : cliRows.filter((row) => acpFamilies.has(modelFamilyId(row.id)))
    const folded = foldAgyModelFamilies([
      ...acpRows,
      ...filteredCliRows,
    ])
    // 目录可能在 CLI 缓存读取期间更新；旧折叠结果不能覆盖新观测。
    if (generation === this.#catalogFoldGeneration) {
      this.#familyTiers = folded.tiers
      this.#foldedFamilies = new Map(folded.models.map((model) => [model.id, model]))
    }
    return folded
  }

  /**
   * 官方 CLI 模型清单的原始行（并发 single-flight；失败返回空）。
   * 每次读取底层缓存的最新快照，不永久记忆非空旧结果，后台刷新才能可见。
   */
  async #cliRawRows(): Promise<readonly { id: string; name: string }[]> {
    const load = this.#loadCliCatalog
    if (!load) return []
    this.#cliCatalog ??= (async () => {
      try {
        return await load()
      } catch {
        return []
      }
    })()
    const inflight = this.#cliCatalog
    try {
      return await inflight
    } finally {
      // 只合并并发读取；底层目录可能已完成后台刷新，不能永久记住旧快照。
      if (this.#cliCatalog === inflight) this.#cliCatalog = undefined
    }
  }

  /** 读一次目录缓存（结果记忆在实例上，避免每次列目录都碰文件系统）。 */
  async #cachedModels(provider: string): Promise<LlmModelInfo[]> {
    this.#cacheLoad ??= (async () => {
      if (!this.#loadCachedCatalog) return []
      try {
        const cached = await this.#loadCachedCatalog()
        if (!cached) return []
        // 档位选择器也随目录一起恢复：重启后、首次会话之前，思考强度菜单就已经
        // 是 agent 上次声明的那一档，而不是凭空编的三档。
        this.#restoreThoughtLevel(cached.thoughtLevel)
        const rows = cached.models
        if (rows.length === 0) return []
        return rows.map((row) => {
          // 缓存里若带实测上下文容量，重启后压缩引擎无需等下一次 usage_update。
          if (typeof row.contextWindow === 'number' && Number.isFinite(row.contextWindow) && row.contextWindow > 0) {
            this.#rememberContextWindow(row.id, row.contextWindow)
          }
          const entry: LlmModelInfo = { provider, id: row.id, name: row.name, inputModalities: ['text'] }
          return row.description === undefined ? entry : { ...entry, description: row.description }
        })
      } catch {
        // 缓存读不出来不是错误，退回占位即可。
        return []
      }
    })()
    return this.#cacheLoad
  }

  /**
   * 本 provider **不声明**任何可重试失败码：宿主若整步重放 `stream()`，握手失败会
   * 重复 spawn、认证超时会重复弹登录、prompt 超时会重放全部历史与工具调用。详见
   * 文件里「关于失败重试」的说明。
   *
   * 注意返回 `undefined` 会让宿主装上自己的默认政策；它对本 provider 不生效的
   * 前提（我们只抛 `AGY_` 前缀码）由测试锁住，不是靠这里的注释维持。
   */
  override providerRetryPolicy(_provider: string) {
    return undefined
  }

  /**
   * 精确模型解析。按 dsh-llm 的目录语义，目录成员资格是**建议性**的
   * （catalog membership remains advisory），因此这里不因未登记的 id 报错；
   * 真正的能力拒绝发生在 ACP 会话侧（模型不存在时 agent 自行报错）。
   */
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // 显示名与档位不能只依赖此前是否有人列过目录；跨 worker 导入目录后
    // 也要走同一份折叠结果。这里仅读缓存，不启动 ACP 连接。
    const folded = await withAbort(this.#foldCatalog(provider), signal)
    throwIfAborted(signal)
    const families = new Map(folded.models.map((entry) => [entry.id, entry]))
    const tiers = folded.tiers
    // DSH 的路由键是折叠后的家族 id（`claude-opus-5-5`），而 `#catalog` 只含
    // ACP 声明的档位 id（`…-high`）。查不到时用最近一次折叠结果补上显示名，
    // 不要退化成裸 id。
    const known = this.#catalog.find((entry) => entry.id === model)
      ?? families.get(model)
    // 显示名覆盖对已知与未知路由键都生效：用户在设置页改了名字，选择器与
    // 会话标题都要一致，不能只在 listModels 里生效。
    const displayName = modelDisplayName(this.#modelSettingsSnapshot(), model, known?.name ?? model)
    // 上下文容量优先用实测值（usage_update.size / 缓存）；没观测过的模型用
    // 可配置的兜底窗口，否则 DSH 切换模型时没有容量可用、压缩直接失败。
    const contextWindow = this.#contextWindows.get(model)
      ?? fallbackContextWindow(model, this.#defaultContextWindow)
    // 没有档位变体的模型必须省略 reasoning（宿主拒绝空 efforts）。
    const reasoning = this.#reasoningInfo(model, tiers)
    return {
      provider,
      id: model,
      name: displayName,
      ...(this.#inputModalities() === undefined ? {} : { inputModalities: this.#inputModalities() }),
      ...(known?.description === undefined ? {} : { description: known.description }),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      // 思考强度菜单：优先取 agent 声明的 thought_level 选项（ACP 1.5+），
      // 旧 agent 才退回「档位编进模型 id」的目录推断。
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /**
   * 该路由可选的思考强度；缺省档位取 agent 声明的当前值，否则官方默认 medium。
   *
   * 有两个来源，优先级固定：
   * 1. **agent 的 `thought_level` 选择器**（ACP 1.5+）：档位是模型元数据，
   *    每个模型能选哪几档由 agent 声明，标签也用它自己的（Low/Medium/High/Extra）。
   * 2. 旧 agent 没有独立档位通道：用官方档位化目录推出的三档 + 中文标签。
   *
   * 返回 undefined 表示「此模型没有思考强度菜单」；宿主把 `efforts: []` 判为
   * 非法元数据（INVALID_MODEL_REASONING）并使该模型不可用，所以不支持档位的
   * 模型必须**省略 reasoning 字段**，不能给空数组。
   */
  #reasoningInfo(model: string, familyTiers = this.#familyTiers): LlmModelReasoningInfo | undefined {
    const thought = this.#thoughtLevel
    if (thought) {
      let efforts = reasoningsFrom(thought.options)
      // `thought_level` 的选项跟随 agent **当前模型**：
      // - 会话停在 Argon 时，选项里不会有 Hydrogen 的 `xhigh` → 并上 CLI 目录里该家族真实存在的档位；
      // - 会话（或 catalog.json 缓存）停在 Hydrogen 时，选项里带了 `xhigh` 和 `currentValue: "xhigh"`，
      //   切到 Argon/Neon/Flash 时若原样照搬，会让不支持 xhigh 的模型默认选上 xhigh。
      // 因此当 CLI 目录已明确知道该家族有哪些档位（tiers.size > 0）时，同时按它过滤掉不属于该家族的档位。
      const tiers = familyTiers.get(modelFamilyId(model))
      if (tiers !== undefined && tiers.size > 0) {
        efforts = efforts.filter((entry) => tiers.has(entry.id.toString() as AgyModelTier))
        for (const tier of tiers) {
          if (efforts.some((entry) => entry.id.toString() === tier)) continue
          efforts.push({ id: ReasoningEffortId(tier), name: TIER_LABELS[tier] ?? tier })
        }
      }
      if (efforts.length === 0) return undefined
      efforts.sort((a, b) => effortRank(a.id.toString()) - effortRank(b.id.toString()))
      const preferred = thought.currentValue === undefined
        ? undefined
        : efforts.find((entry) => entry.id === ReasoningEffortId(thought.currentValue as string))
      // 当前值可能来自别的模型（例如 Hydrogen 的 xhigh 切到 Argon 后不在选项里），
      // 这时退回官方默认 medium（或列表最后一项），绝不指向该模型不存在的档位。
      const fallback = preferred
        ?? efforts.find((entry) => entry.id === ReasoningEffortId(DEFAULT_AGY_REASONING_EFFORT))
        ?? efforts[efforts.length - 1]
      return { efforts, ...(fallback ? { defaultEffort: fallback.id } : {}) }
    }
    // 旧协议兼容：档位被编进模型 id，只能从目录里推断有哪些档位。
    const tiers = familyTiers.get(modelFamilyId(model))
    // 已知该 id 没有档位变体（目录里的普通 id）：强度菜单不适用，不声明 reasoning。
    if (tiers !== undefined && tiers.size === 0) return undefined
    const efforts = AGY_REASONING_EFFORTS
      .filter((effort) => tiers === undefined || tiers.has(effort))
      .map((effort) => ({
        id: ReasoningEffortId(effort),
        name: AGY_REASONING_EFFORT_NAMES[effort],
      }))
    const fallback = efforts.find((entry) => entry.id === ReasoningEffortId(DEFAULT_AGY_REASONING_EFFORT))
    return { efforts, ...(fallback ? { defaultEffort: fallback.id } : {}) }
  }

  /** 池已选定 worker 后，为该连接协商图片能力；不建会话、不发送 prompt。 */
  async prepareImages(signal?: AbortSignal): Promise<void> {
    if (this.#readImage && (this.#canReadImages?.() ?? true) && this.#imageSupported === undefined) await this.warmup(signal, true)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    // Request preparation runs before DSH projects image blocks. Discovery here only
    // handshakes; passive listModels/resolveModel remain free of connection I/O.
    await this.prepareImages(signal)
    const modelInfo = await this.resolveModel(provider, model, signal)
    return {
      model: modelInfo,
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 一次模型调用的 chunk 流。
   *
   * 判定「续轮 vs 新轮」：messages 尾部的连续 tool 结果消息与当前回合 park
   * 的 MCP 调用**按顺序一一匹配**且该回合的 ACP prompt 尚未应答 → 续轮；
   * 否则按新轮处理（放弃旧回合；有历史时走 `session/resume` 接回，不复用即报错，不重放）。
   * 并发防御：主对话与标题/压缩请求可以同时进入同一个 adapter；从首个 await
   * 之前串行化 stream。工具 park 保留回合所有权，辅助请求等待而不是抢占主回合。
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // temperature / stop 在 ACP v1 没有会话通道：不因它们拒绝整个请求（否则宿主里
    // 任何携带这两个字段的流程都会整单失败），只明确告知「值不生效」。
    const unsupported = unsupportedOptions(options)
    if (unsupported.length > 0) {
      this.#log?.warn(`antigravity-acp: 忽略不支持的请求项 ${unsupported.join('、')}（ACP v1 无对应会话通道，值不会生效）`)
    }
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: {
        code: AGY_TURN_ERROR.ABORTED, message: 'Antigravity ACP 请求在发起前已取消',
      } } }
      return
    }
    await this.#acquireStream(options)
    if (!this.#turn || this.#isTurnClosed(this.#turn)) this.#refreshSettings()
    this.#clearIdleRecycle()
    let handedOff = false
    try {
      for await (const chunk of this.#streamExclusive(options)) {
        if (chunk.type === 'block-end') this.#continuationState?.emitted(chunk.block)
        // 消费者在收到 finish 后 return 是合法的（尤其是工具续轮）。
        if (chunk.type === 'finish') handedOff = true
        yield chunk
      }
    } finally {
      if (!handedOff && this.#turn && !this.#isTurnClosed(this.#turn)) {
        this.#abandonTurn('消费者提前关闭流，取消未完成回合')
      }
      this.#streamActive = false
      this.#maybeIdle()
      this.#wakeAccessWaiters()
    }
  }

  /* ── ACP 会话复用 ─────────────────────────────────────────────────── */

  /** 只把真正影响官方路由的覆盖项纳入指纹，改名和显示开关不触发无谓重建。 */
  #sessionRouteFingerprint(options: GenerateOptions): string {
    const setting = modelSettingFor(this.#modelSettingsSnapshot(), options.model)
    const override = setting.target === undefined ? undefined : { target: setting.target }
    return routeFingerprint(options, override)
  }

  /**
   * 跨进程恢复：用磁盘上的会话映射接上原 ACP 会话（只走 `session/resume`）。
   *
   * 这里**没有回退**：任何一条校验不通过都直接让这一轮失败，而不是悄悄把整段
   * 历史当文本重灌（那会消耗几十万 token 并把模型带回旧任务）。没有 `session/load`
   * 退路——旧 agent 不支持 resume 时同样报错。
   */
  async #resumeSession(options: GenerateOptions, key: string, entry?: SessionMapEntry): Promise<ReusedSession> {
    const fail = (reason: string): never => {
      // 不删映射：校验失败只否定「这一轮能否续上」，不代表 ACP 会话已失效。
      // 保留条目让后续轮次（或换回正确历史后）仍能尝试 session/resume。
      throw new LlmError(
        `无法接上原 ACP 会话（${reason}）。已禁用回退重放：请新开一个会话，或恢复该映射后再试。`,
        AGY_ADAPTER_ERROR.SESSION_UNRECOVERABLE,
      )
    }
    if (!this.#resumeSessions) return fail('resumeSessions 未开启')
    if (!entry) return fail('没有可用的会话映射')
    if (entry.cwd !== this.#cwd) return fail('会话工作目录与当前不一致')
    // 路由（模型/档位/系统提示/工具目录）变化不再判死：resume 之后会
    // #applyModelSelection 应用当前模型与档位；system 与工具目录在会话创建时固定。
    if (options.messages.length <= entry.sentCount) return fail('没有新增消息')
    if (!prefixMatches(options.messages, entry.sentCount, entry.sentHash)) return fail('历史不是已发送前缀的追加')
    if (!outputMatches(options.messages.slice(entry.sentCount), entry.outputHash)) return fail('上一轮输出已变化或来自其他会话')
    if (options.messages.slice(entry.sentCount).some((message) => message.role === 'tool')) return fail('新增消息包含工具结果')
    if (incrementalMessages(options.messages, entry.sentCount).length === 0) return fail('没有可发送的增量')
    // 启动失败/取消时不能把 claim 留在本 worker 名下：条目内容本身没被否定
    // （只是这次没能起进程），下一个 worker 仍可以尝试接管它。
    let link: AgentLink
    try {
      link = await this.#getLink(this.#handlers, options.signal)
    } catch (error) {
      this.#sessionStore?.unclaim(key, this.#sessionOwner)
      throw error
    }
    this.#observeCapabilities(link)
    const tools = options.tools ?? []
    let mcpServers: AcpMcpServer[] = []
    if (tools.length > 0) {
      this.#bridge.beginRound(tools, key)
      if (!this.#bridge.listening) await this.#bridge.start()
      mcpServers = this.#bridge.acpRegistration()
    }
    if (!link.supportsResumeSession()) return fail('agent 未声明 session/resume')
    this.#suppressUpdates += 1
    let resumedResponse: Awaited<ReturnType<AgentLink['resumeSession']>>
    try {
      const timeoutMs = Math.min(this.#promptTimeoutMs, this.#sessionTimeoutMs)
      const request = {
        sessionId: entry.sessionId,
        cwd: this.#cwd,
        mcpServers,
        _meta: { antigravity: { enabledTools: [], eagerMcpServers: tools.length > 0 ? [BRIDGE_MCP_SERVER_NAME] : [] } },
      }
      resumedResponse = await link.resumeSession(request, { signal: options.signal, timeoutMs })
      // load 恢复的是既有会话：它的 system prompt 已在创建时确定，这里既不重发
      // meta（会重复追加）也不塞文本块（会重复指令）。
      this.observeSessionConfigOptions(resumedResponse.configOptions)
      if (findModelSelector(resumedResponse.configOptions)) this.#rememberSessionModelSelector(entry.sessionId)
      throwIfAborted(options.signal)
    } catch (error) {
      this.#log?.warn(`antigravity-acp: 会话恢复失败（session/resume）session=${entry.sessionId}`, error)
      // 恢复失败可能仍有迟到回放：回收连接，然后把失败明确抛给宿主。
      this.#bridge.invalidateRound('恢复失败')
      this.#scheduleRecycle(link)
      await this.#settleRecycle()
      throwIfAborted(options.signal)
      return fail(`session/resume 失败：${(error as { message?: string }).message ?? String(error)}`)
    } finally {
      this.#suppressUpdates -= 1
    }
    try {
      await this.#applyModelSelection(link, entry.sessionId, options.model, options.reasoningEffort, options.signal)
      await this.#applyAgentMode(link, entry.sessionId, resumedResponse.modes, options.signal)
      throwIfAborted(options.signal)
    } catch (error) {
      // session/resume 已成功建立，失败的只是选模/档位配置（例如选了当前认证不支持的模型）：
      // 关闭该对端会话并归还磁盘 claim，既不杀健康的 ACP 进程，也不伪装成 SESSION_UNRECOVERABLE
      // 触发无意义的重放（重放同样会在同一模型上被拒）；用户换回可用模型后下一轮仍可 resume。
      this.#closeSession(link, entry.sessionId)
      this.#sessionStore?.unclaim(key, this.#sessionOwner)
      throwIfAborted(options.signal)
      throw error
    }
    const record: ReusedSession = {
      key,
      sessionId: entry.sessionId,
      link,
      sentCount: entry.sentCount,
      sentHash: entry.sentHash,
      outputHash: entry.outputHash,
      // 恢复后模型/档位已按当前路由应用，指纹同步到当前值，避免下一轮误判变化。
      route: this.#sessionRouteFingerprint(options),
      usesTools: tools.length > 0,
    }
    this.#sessions.set(key, record)
    this.#log?.info(`antigravity-acp: 已恢复 ACP 会话 session=${entry.sessionId} 已发送消息=${entry.sentCount}`)
    return record
  }

  /**
   * DSH 会话已被宿主销毁：关闭对应 ACP 会话并删除恢复映射。
   *
   * 由插件在 `session/disposed` 事件里调用，避免宿主删了会话、这里还留着
   * ACP 会话与 `sessions.json` 条目。
   */
  releaseConversation(dshSessionId: string): void {
    const key = `${dshSessionId}::chat`
    const record = this.#sessions.get(key)
    if (record) {
      this.#dropSession(record, 'DSH 会话已销毁', true)
      return
    }
    // 内存里没有记录（进程重启过）也要删掉磁盘映射，否则下次 resume 会接回一个已删会话：
    // 重启后 store 的 owner 表为空，普通 delete 会静默失效，这里必须无条件删除。
    void this.#sessionStore?.purge(key)
  }

  /**
   * 找到可复用的会话。任何失效都只**丢弃内存记录并保留磁盘映射**，交给
   * `session/resume` 接回；模型/档位变化不丢弃会话，由 `#runNewRound` 直接应用到
   * 既有 ACP 会话（`session/set_config_option`）。
   */
  #findReusableSession(options: GenerateOptions, key: string): ReusedSession | undefined {
    const record = this.#sessions.get(key)
    if (!record) return undefined
    if (this.#resumeSessions && this.#sessionStore && !this.#sessionStore.owns(key, this.#sessionOwner)) {
      // 会话已被连接池换到另一个 worker：关闭本进程的副本（已验证 close 后仍可 resume），
      // 映射保留给新 owner；否则两个进程会同时持有同一条 ACP 会话。
      this.#dropSession(record, '会话已迁移到其他 worker')
      return undefined
    }
    // 进程没了：只丢掉内存记录，**保留磁盘映射**，交给 resume 接回原会话。
    if (record.link.closed) {
      this.#forgetSession(record, 'ACP 链接已关闭')
      return undefined
    }
    // 用过工具的会话依赖桥的授权代次：桥被另一个对话接管后它的 MCP 连接
    // 持有旧 token，沿用只会让工具调用被拒；关掉对端会话后交给 resume 重新注册桥。
    if (record.usesTools && this.#bridge.owner !== record.key) {
      this.#dropSession(record, 'MCP 桥已被其他对话接管')
      return undefined
    }
    if (options.messages.length <= record.sentCount) {
      this.#dropSession(record, '没有严格追加的新输入')
      return undefined
    }
    if (!prefixMatches(options.messages, record.sentCount, record.sentHash)) {
      this.#dropSession(record, '历史已不是已发送前缀的追加（压缩、回退或编辑）')
      return undefined
    }
    if (record.cancelled !== true && !outputMatches(options.messages.slice(record.sentCount), record.outputHash)) {
      this.#dropSession(record, '上一轮输出已变化或来自其他会话')
      return undefined
    }
    // 新增部分若含工具结果，只能走 MCP 回喂，不能当 prompt 文本重发。
    if (options.messages.slice(record.sentCount).some((message) => message.role === 'tool')) {
      this.#dropSession(record, '新增消息包含工具结果')
      return undefined
    }
    if (incrementalMessages(options.messages, record.sentCount).length === 0) {
      this.#dropSession(record, '没有可发送的增量，按完整历史重建')
      return undefined
    }
    return record
  }

  /** 记录一个刚建立会话 / 刚完成全量发送的 ACP 会话。 */
  #rememberSession(options: GenerateOptions, key: string, link: AgentLink, sessionId: string): ReusedSession {
    const record: ReusedSession = {
      key,
      sessionId,
      link,
      sentCount: options.messages.length,
      sentHash: prefixHash(options.messages),
      route: this.#sessionRouteFingerprint(options),
      usesTools: (options.tools?.length ?? 0) > 0,
    }
    this.#sessions.set(key, record)
    return record
  }

  /** 在 finish 对外可见之前提交输入与实际交付输出，消费者可立即 return。 */
  #advanceSession(record: ReusedSession, options: GenerateOptions, blocks: readonly ContentBlock[], settled: boolean): void {
    if (this.#sessions.get(record.key) !== record) return
    record.sentCount = options.messages.length
    record.sentHash = prefixHash(options.messages)
    record.outputHash = outputHash(blocks)
    // 取消标记只豁免一轮输出指纹校验：本轮已完整交付后，后续回合重新按指纹验证。
    if (settled) record.cancelled = false
    this.#sessions.delete(record.key)
    this.#sessions.set(record.key, record)
    if (settled) this.#sessionStore?.set(record.key, this.#sessionOwner, {
      sessionId: record.sessionId, cwd: this.#cwd, sentCount: record.sentCount,
      sentHash: record.sentHash, outputHash: record.outputHash, route: record.route, updatedAt: Date.now(),
    })
    else this.#sessionStore?.delete(record.key, this.#sessionOwner)
  }

  /**
   * 记录某 ACP 会话已确认写入的模型值。上限与会话复用表一致（64），
   * Map 保持插入序，超出时淘汰最早的一条，避免长进程里无界增长。
   */
  #rememberSessionModelValue(sessionId: string, value: string): void {
    this.#sessionModelValues.delete(sessionId)
    this.#sessionModelValues.set(sessionId, value)
    while (this.#sessionModelValues.size > 64) {
      const oldest = this.#sessionModelValues.keys().next().value
      if (oldest === undefined) break
      this.#sessionModelValues.delete(oldest)
    }
  }

  /**
   * 记录「本会话自己声明过 model 选择器」。与会话复用表同一上限，超出时淘汰
   * 最早的一条并连带清掉它的模型值记录。
   */
  #rememberSessionModelSelector(sessionId: string): void {
    this.#sessionModelDeclared.delete(sessionId)
    this.#sessionModelDeclared.add(sessionId)
    while (this.#sessionModelDeclared.size > 64) {
      const oldest = this.#sessionModelDeclared.values().next().value
      if (oldest === undefined) break
      this.#sessionModelDeclared.delete(oldest)
      this.#sessionModelValues.delete(oldest)
      this.#sessionThoughtValues.delete(oldest)
    }
  }

  /** 记录某 ACP 会话已确认写入的档位值；上限与模型值记录一致。 */
  #rememberSessionThoughtValue(sessionId: string, value: string): void {
    this.#sessionThoughtValues.delete(sessionId)
    this.#sessionThoughtValues.set(sessionId, value)
    while (this.#sessionThoughtValues.size > 64) {
      const oldest = this.#sessionThoughtValues.keys().next().value
      if (oldest === undefined) break
      this.#sessionThoughtValues.delete(oldest)
    }
  }

  /**
   * 只丢弃内存记录，**保留磁盘映射**，也不关闭对端会话：会话本身没有被否定，
   * 下一条请求会走 `session/resume` 接回（典型场景：会话被连接池换到另一个 worker）。
   */
  #forgetSession(record: ReusedSession, reason: string): void {
    if (this.#sessions.get(record.key) !== record) return
    this.#sessions.delete(record.key)
    this.#sessionModelValues.delete(record.sessionId)
    this.#sessionModelDeclared.delete(record.sessionId)
    this.#sessionThoughtValues.delete(record.sessionId)
    this.#systemViaMeta.delete(record.sessionId)
    this.#log?.info(`antigravity-acp: 放弃内存复用，保留恢复映射（${reason}）`)
  }

  /**
   * 丢弃内存记录并关闭对端会话（`session/close` 之后仍可被 `session/resume` 接回）。
   * 默认**保留磁盘映射**：一次失败不等于会话失效，下一轮还能恢复；只有宿主删除
   * 该 DSH 会话（`releaseConversation`）时才显式删除映射。
   */
  #dropSession(record: ReusedSession, reason: string, dropMapping = false): void {
    if (this.#sessions.get(record.key) !== record) return
    this.#sessions.delete(record.key)
    if (dropMapping) this.#sessionStore?.delete(record.key, this.#sessionOwner)
    this.#sessionModelValues.delete(record.sessionId)
    this.#sessionModelDeclared.delete(record.sessionId)
    this.#sessionThoughtValues.delete(record.sessionId)
    this.#systemViaMeta.delete(record.sessionId)
    this.#log?.info(`antigravity-acp: 放弃 ACP 会话复用（${reason}；${dropMapping ? '删除映射' : '保留映射'}）`)
    this.#closeSession(record.link, record.sessionId)
  }

  #dropSessionsForLink(link: AgentLink, reason: string): void {
    for (const record of [...this.#sessions.values()]) {
      if (record.link === link) this.#dropSession(record, reason)
    }
  }

  #dropSessionsForTurn(sessionId: string, reason: string): void {
    for (const record of [...this.#sessions.values()]) {
      if (record.sessionId === sessionId) this.#dropSession(record, reason)
    }
  }

  /**
   * 卸载 / 空闲回收时关闭所有对端会话，但**保留**磁盘映射：那正是下次`session/resume`
   * 接回的依据（接不上就报错，不重放）。除宿主删除会话（releaseConversation）外，
   * 插件不再主动删除映射。
   */
  #dropAllSessions(reason: string, link?: AgentLink): void {
    for (const record of [...this.#sessions.values()]) {
      if (link && record.link !== link) continue
      this.#sessions.delete(record.key)
      this.#sessionModelValues.delete(record.sessionId)
      this.#sessionModelDeclared.delete(record.sessionId)
      this.#sessionThoughtValues.delete(record.sessionId)
      this.#log?.info(`antigravity-acp: 关闭 ACP 会话（${reason}）`)
      this.#closeSession(record.link, record.sessionId)
    }
  }

  /** 跟踪尽力关闭请求，卸载时等待它们结束；错误不影响当前对话。 */
  #closeSession(link: AgentLink, sessionId: string): void {
    const pending = link.closeSession(sessionId).catch(() => {
      if (!link.closed) this.#log?.warn('antigravity-acp: session/close 失败，会话由进程退出清理')
    }).finally(() => this.#sessionCloses.delete(pending))
    this.#sessionCloses.add(pending)
  }

  #maybeIdle(): void {
    const link = this.#currentLink
    if (this.#disposed || this.busy || this.#unrecycledLink || !link || link.closed) return
    this.#scheduleIdleRecycle(link)
  }

  /** 只有没有活动请求、工具 park 或取消排空时才启动空闲计时。 */
  #scheduleIdleRecycle(link: AgentLink): void {
    this.#clearIdleRecycle()
    if (this.#idleRecycleMs <= 0 || this.#disposed || this.busy || link.closed) return
    const timer = setTimeout(() => {
      if (this.#idleRecycle?.timer !== timer) return
      this.#idleRecycle = undefined
      if (this.busy || this.#disposed || this.#currentLink !== link || link.closed) return
      this.#log?.info(`antigravity-acp: 进程空闲 ${this.#idleRecycleMs}ms 无新消息，回收`)
      this.#scheduleRecycle(link, true)
    }, this.#idleRecycleMs)
    timer.unref?.()
    this.#idleRecycle = { timer, link }
  }

  #clearIdleRecycle(): void {
    const idle = this.#idleRecycle
    if (!idle) return
    clearTimeout(idle.timer)
    this.#idleRecycle = undefined
  }

  /**
   * 等待取消排空与回收。普通聊天保留旧语义：上一次回收失败先报告给本轮，
   * 同时在后台重试；显式预热/目录刷新则等待本次补试，不无限自旋。
   */
  async #settleRecycle(retryFailed = false): Promise<void> {
    // 本地 aborted 不是停止证明；新回合不能撤销旧回合的排空屏障。
    await this.#cancelGrace?.pending
    try {
      await this.#cleanup
    } catch (error) {
      const stuck = this.#unrecycledLink
      this.#cleanup = stuck === undefined
        ? Promise.resolve()
        : this.#recycleLink(stuck).then(() => {
          if (this.#unrecycledLink === stuck) this.#unrecycledLink = undefined
        })
      void this.#cleanup.catch(() => undefined)
      if (retryFailed) return await this.#cleanup
      throw error
    }
  }

  /**
   * 取消后的宽限：等 agent 应答 `cancelled` 再决定是否回收进程。
   *
   * 官方 `session/cancel` 是通知，不代表执行已停止；直接保留进程可能让它继续
   * 跑旧会话。因此默认仍立即回收；开启 keepProcessAfterCancel 后：
   * - 宽限内收到 prompt 应答（取消生效）→ 只丢弃会话，保留进程；
   * - 超时未应答 → 按原策略回收；
   * - cancelGraceMs = 0 → 不等待，立即回收。
   */
  #scheduleCancelGrace(link: AgentLink, turn: PromptTurn): void {
    this.#clearCancelGrace()
    // prompt 已经应答（例如 cancelled）：agent 已停，直接保留，不设宽限。
    if (turn.promptSettled) {
      this.#log?.info('antigravity-acp: 取消已被 agent 应答，保留 ACP 进程与会话')
      this.#maybeIdle()
      this.#wakeAccessWaiters()
      return
    }
    if (this.#cancelGraceMs <= 0) {
      this.#scheduleRecycle(link)
      return
    }
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    const timer = setTimeout(() => {
      this.#log?.warn(`antigravity-acp: 取消后 ${this.#cancelGraceMs}ms 内未收到 agent 确认，回收进程`)
      this.#scheduleRecycle(link)
    }, this.#cancelGraceMs)
    timer.unref?.()
    this.#cancelGrace = { timer, link, turn, pending, resolve }
    this.#log?.info(`antigravity-acp: 取消后保留进程，最多等待 ${this.#cancelGraceMs}ms 供 agent 停止`)
  }

  /** agent 已应答（取消生效）：撤销回收，只丢弃会话。 */
  #confirmCancelGrace(turn: PromptTurn): void {
    const grace = this.#cancelGrace
    if (!grace || grace.turn !== turn) return
    this.#clearCancelGrace()
    this.#log?.info('antigravity-acp: agent 已确认停止，保留 ACP 进程')
    this.#maybeIdle()
    this.#wakeAccessWaiters()
  }

  #clearCancelGrace(): void {
    const grace = this.#cancelGrace
    if (!grace) return
    clearTimeout(grace.timer)
    this.#cancelGrace = undefined
    grace.resolve()
  }

  /** 先允许当前拒绝响应出站，再回收；同一连接的接管/取消不得重复覆盖屏障。 */
  #scheduleRecycle(link: AgentLink, preserveMapping = false): void {
    this.#clearCancelGrace()
    this.#clearIdleRecycle()
    if (preserveMapping) this.#dropAllSessions('空闲回收，保留恢复映射', link)
    else this.#dropSessionsForLink(link, 'ACP 链接回收')
    if (this.#currentLink === link) this.#currentLink = undefined
    if (this.#unrecycledLink === link) return
    this.#unrecycledLink = link
    this.#cleanup = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => this.#recycleLink(link))
      .then(() => {
        if (this.#unrecycledLink === link) this.#unrecycledLink = undefined
      })
    void this.#cleanup.catch((error: unknown) => this.#log?.warn('antigravity-acp: 回合回收失败', error))
  }

  /** 同一时刻只有一个 stream 能创建/切换会话或消费回合队列。 */
  async *#streamExclusive(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const state = this.#continuationState
    const tail = trailingToolResults(options.messages, state)
    let turn = this.#turn
    if (turn?.awaitingToolResults) {
      // 能续轮的前提有两个：ACP prompt 尚未应答（同一 prompt 内才能继续
      // 产出），且尾部 tool 结果与 park 表按调用 id 一一匹配。
      if (!turn.promptSettled && matchesParkedCalls(turn, tail, this.#bridge) && state?.accepts(options, tail.length)) {
        // 尾部尚未发出的 user 消息（宿主通知 / 用户插话）在续轮里没有第二条
        // prompt 可发：附到最后一条工具结果里，agent 才能看到「后台任务完成」
        // 「子代理完成」「用户插话」这类一次性内容；漏投递会让主代理永远读不到
        // 子代理结果，判定失败则会丢会话并让整轮不可恢复。
        const unsent = state.trailingUnsentUserMessages(options.messages)
        const note = tailDeliveryNote(unsent)
        // 续轮接受后重置账本：本批 assistant 块必须记在**新**状态上，否则下一批
        // 工具调用的 accepts() 会把这两批块累加比较而永远失败。
        this.#continuationState = new ContinuationState(options)
        if (note !== undefined) {
          this.#log?.info(`antigravity-acp: 续轮投递尾部未发送消息 ${unsent.length} 条（宿主通知/用户插话）`)
        }
        yield* this.#runContinuation(turn, options, tail, note)
        return
      }
      // 不匹配（或 agent 已经收尾）→ 放弃旧回合，按新轮重新校验。历史接不上
      // 原 ACP 会话时 #runNewRound 直接报 AGY_SESSION_UNRECOVERABLE，绝不重放。
      this.#abandonTurn('续轮条件不满足（工具结果、路由、上下文或工具定义已变化，或 ACP prompt 已应答），按新轮重新校验')
      turn = undefined
    }
    if (turn && !this.#isTurnClosed(turn)) {
      throw new LlmError(
        'Antigravity ACP 同一时刻只允许一路活跃 stream：当前回合仍在进行中，本请求既不是其续轮，也无法安全抢占',
        AGY_ADAPTER_ERROR.BUSY,
      )
    }
    yield* this.#runNewRound(options)
  }

  #wakeAccessWaiters(): void {
    const waiters = [...this.#accessWaiters]
    this.#accessWaiters.clear()
    for (const wake of waiters) wake()
  }

  #sameTurnOwner(options: GenerateOptions): boolean {
    return this.#turnOwner?.sessionId === options.sessionId && this.#turnOwner?.purpose === options.purpose
  }

  async #acquireStream(options: GenerateOptions): Promise<void> {
    for (;;) {
      if (this.#disposed) throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')
      if (options.signal?.aborted) throw new LlmError('Antigravity ACP 请求在等待调度时被取消', AGY_TURN_ERROR.ABORTED)
      // 压缩由主循环在下一步之前同步等待，不能排在它自己尚未回喂的工具回合后面；
      // 同会话压缩沿用下方的 abandon + 完整历史重建兜底，标题等后台请求则必须等待。
      const inlineCompaction = options.purpose === 'compaction' && this.#turnOwner?.sessionId === options.sessionId
      const foreignPark = this.#turn?.awaitingToolResults && !this.#sameTurnOwner(options) && !inlineCompaction
      if (!this.#streamActive && !foreignPark) {
        this.#streamActive = true
        return
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.#accessWaiters.delete(wake)
          options.signal?.removeEventListener('abort', onAbort)
        }
        const wake = (): void => { cleanup(); resolve() }
        const onAbort = (): void => {
          cleanup()
          reject(new LlmError('Antigravity ACP 请求在等待调度时被取消', AGY_TURN_ERROR.ABORTED))
        }
        this.#accessWaiters.add(wake)
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.signal?.aborted) onAbort()
      })
    }
  }

  /** 启动阶段也响应取消；迟到资源先回收，后续回合不能越过清理屏障。 */
  async #prepareRound(options: GenerateOptions, owner?: string) {
    let link: AgentLink | undefined
    let createdSessionId: string | undefined
    const check = (): void => {
      if (this.#disposed) throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')
      throwIfAborted(options.signal)
    }
    const setup = (async () => {
      check()
      link = await this.#getLink(this.#handlers, options.signal)
      this.#observeCapabilities(link)
      check()
      const tools = options.tools ?? []
      let mcpServers: AcpMcpServer[] = []
      // 无工具的一次性请求（标题、压缩）不接管桥：轮换 token 会让同一 worker 上
      // 仍在复用的 ACP 会话失去工具连接。
      if (tools.length > 0) this.#bridge.beginRound(tools, owner)
      if (tools.length > 0) {
        if (!this.#bridge.listening) await this.#bridge.start()
        check()
        mcpServers = this.#bridge.acpRegistration()
      }
      // 官方 1.4.0 tool_filter.py / mcp_servers.py 的会话扩展：禁用内置工具
      // （仅关闭 ACP clientCapabilities 不够），直接向模型加载完整 MCP schema。
      this.#lifecycle?.roundPhase('session')
      const systemViaMeta = options.system !== undefined && options.system !== '' && link.supportsSystemPromptAppend()
      const session = await link.newSession({
        cwd: this.#cwd,
        mcpServers,
        _meta: { antigravity: {
          enabledTools: [],
          eagerMcpServers: tools.length > 0 ? [BRIDGE_MCP_SERVER_NAME] : [],
          // agent 声明支持时把 system prompt 交给它追加到自己的系统提示里；否则
          // 继续编成 `<dsh-system>` 文本块（见 stream 的 prompt 组装）。
          ...(systemViaMeta ? { systemPrompt: { append: options.system } } : {}),
        } },
      }, { signal: options.signal, timeoutMs: this.#sessionTimeoutMs })
      createdSessionId = session.sessionId
      check()
      if (systemViaMeta) this.#systemViaMeta.add(session.sessionId)
      this.observeSessionConfigOptions(session.configOptions)
      if (findModelSelector(session.configOptions)) this.#rememberSessionModelSelector(session.sessionId)
      this.#lifecycle?.roundPhase('model')
      await this.#applyModelSelection(link, session.sessionId, options.model, options.reasoningEffort, options.signal)
      await this.#applyAgentMode(link, session.sessionId, session.modes, options.signal)
      check()
      return { link, session, tools }
    })()
    try {
      return await withAbort(setup, options.signal)
    } catch (error) {
      if (options.signal?.aborted || this.#disposed) {
        this.#bridge.invalidateRound('启动阶段取消')
        this.#cleanup = setup.catch(() => undefined).then(async () => {
          if (!link) return
          this.#unrecycledLink = link
          await this.#recycleLink(link)
          if (this.#unrecycledLink === link) this.#unrecycledLink = undefined
        })
        void this.#cleanup.catch(() => undefined)
      } else if (link && createdSessionId !== undefined && !link.closed) {
        // session/new 已经成功建立，失败的只是选模/档位配置（例如选了不可用模型）：
        // 只关闭刚建的临时会话，不回收健康的 ACP 进程，避免连带杀掉同连接的其它状态。
        this.#systemViaMeta.delete(createdSessionId)
        this.#sessionModelDeclared.delete(createdSessionId)
        this.#sessionModelValues.delete(createdSessionId)
        this.#sessionThoughtValues.delete(createdSessionId)
        this.#closeSession(link, createdSessionId)
      } else {
        this.#bridge.invalidateRound('ACP 回合准备失败')
        if (link) this.#scheduleRecycle(link)
      }
      throwIfAborted(options.signal)
      throw error
    }
  }

  async *#runNewRound(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.#clearIdleRecycle()
    await withAbort(this.#settleRecycle(), options.signal)
    if (this.#disposed) throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')
    this.#turnOwner = {
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    }
    this.#continuationState = new ContinuationState(options)
    // usage_update 的上下文容量归属到本次请求的 DSH 路由键。
    this.#routeModelId = options.model
    this.#lifecycle?.beginRound(options.model)
    const key = reusableSessionKey(options)
    // 必须先检查旧 owner，再 claim；反过来会把刚接回的陈旧内存记录误认为仍归自己。
    let reused = key === undefined ? undefined : this.#findReusableSession(options, key)
    const entry = key !== undefined && this.#resumeSessions
      ? await withAbort(this.#sessionStore?.claim(key, this.#sessionOwner) ?? Promise.resolve(undefined), options.signal) : undefined
    // 有历史的普通聊天轮必须接上原 ACP 会话；接不上就让这一轮失败。
    // **没有重放路径**：任何形式的历史重灌都会消耗几十万 token、把模型带回旧任务，
    // 还会被上游按体积截断。一次性请求（标题/压缩）自带完整输入，不走这条路径。
    const hasPriorHistory = options.purpose === undefined
      && options.messages.some((message) => message.role === 'assistant' || message.role === 'tool')
    // 会话接不上时的兜底：默认不再让整段对话永久失效，而是用有界历史重放
    // 新建一个 ACP 会话（只放得下最近 messages，更早的省略）。关闭 replayFallback
    // 则保持旧行为：直接报 AGY_SESSION_UNRECOVERABLE。
    let replay = false
    if (!reused && hasPriorHistory) {
      if (key === undefined) {
        throw new LlmError(
          '这段历史没有可接续的 ACP 会话（缺少会话键）。已禁用回退重放：请新开会话。',
          AGY_ADAPTER_ERROR.SESSION_UNRECOVERABLE,
        )
      }
      try {
        reused = await this.#resumeSession(options, key, entry)
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (!this.#replayFallback || code !== AGY_ADAPTER_ERROR.SESSION_UNRECOVERABLE) throw error
        replay = true
        this.#log?.warn(
          `antigravity-acp: 原 ACP 会话无法接上，按有界历史重放新建会话（${(error as { message?: string }).message ?? String(error)}）`,
        )
      }
    }
    const tools = options.tools ?? []
    let link: AgentLink
    let sessionId: string
    if (reused) {
      // 复用：同一 ACP 会话已有原生历史，只发本轮新增消息。
      link = reused.link
      sessionId = reused.sessionId
      // 模型/档位变化不必重建会话：既有 ACP 会话支持 session/set_config_option。
      // system 提示与工具目录在会话创建时已固定，沿用原会话（恢复映射比重建更重要）。
      const route = this.#sessionRouteFingerprint(options)
      if (reused.route !== route) {
        try {
          await this.#applyModelSelection(reused.link, reused.sessionId, options.model, options.reasoningEffort, options.signal)
          reused.route = route
        } catch (error) {
          // 既有会话切到不可用模型/档位失败：保留内存复用记录与磁盘 claim 归还，
          // 用户换回可用模型后下一轮仍可零重放继续。
          if (key !== undefined) this.#sessionStore?.unclaim(key, this.#sessionOwner)
          this.#lifecycle?.failed(error)
          throw error
        }
      }
      this.#log?.info(
        `antigravity-acp: 复用 ACP 会话 session=${sessionId} 已发送消息=${reused.sentCount}` +
          ` 本轮新增=${options.messages.length - reused.sentCount}`,
      )
    } else {
      try {
        const prepared = await this.#prepareRound(options, key)
        link = prepared.link
        sessionId = prepared.session.sessionId
      } catch (error) {
        // 认领成功但本轮没走到 prompt 在途：磁盘条目的 claim 必须归还，否则它
        // 会一直挂在本 worker 名下直到卸载（跨 worker 会覆盖旧 owner，但 owner
        // 映射本身会残留）。条目内容是否仍然有效由恢复校验决定，这里不动它。
        if (key !== undefined) this.#sessionStore?.unclaim(key, this.#sessionOwner)
        this.#lifecycle?.failed(error)
        throw error
      }
    }

    const turn = new PromptTurn(sessionId, {
      link,
      bridge: this.#bridge,
      promptTimeoutMs: purposeTimeoutMs(options.purpose, this.#promptTimeoutMs),
      parkSettleMs: this.#parkSettleMs,
      // 标题生成与压缩这类一次性请求的调用方只消费 chunk，不会回喂工具结果。
      oneShot: options.purpose !== undefined,
      onPromptSettled: (settledTurn, response) => {
        if (this.#cancelGrace?.turn === settledTurn) {
          // 只要 prompt 有应答（不论 stopReason），agent 就已经结束本轮；白名单
          // 只会把未验证的 stopReason 当成“没应答”而多回收一次进程。
          if (response) this.#confirmCancelGrace(settledTurn)
          else this.#scheduleRecycle(link)
        }
      },
      onTerminate: (reason, info) => {
        if (this.#disposed) {
          this.#bridge.invalidateRound(reason)
          this.#dropSessionsForTurn(turn.sessionId, '卸载时终止未完成回合')
          this.#wakeAccessWaiters()
          return
        }
        this.#lifecycle?.failed(reason)
        this.#releaseTurnSubscription(turn)
        // 用户取消不是「回合异常」：它是想改提示词再发。会话、映射与进程都保留，
        // 下一轮优先按增量续上；只有非取消的异常终止才丢弃会话。
        const cancelled = info?.aborted === true && turn.promptStarted
        if (cancelled) {
          const own = [...this.#sessions.values()].find((item) => item.sessionId === turn.sessionId)
          if (own) own.cancelled = true
        }
        if (info?.clean !== true) {
          this.#bridge.invalidateRound(reason)
          if (!cancelled) this.#dropSessionsForLink(link, '回合异常终止')
        }
        if (info?.clean === true) {
          // prompt 已正常应答的干净失败（refusal / 空回复等）：agent 状态自洽，
          // 链接可复用——不为下一次对话重新 spawn 官方进程、不重弹登录。
          // 只清未回喂的 park，不轮换 token/owner（否则带工具的会话无法复用）。
          this.#bridge.resetPending(reason)
          this.#wakeAccessWaiters()
          return
        }
        // 用户取消：等 agent 确认停止后保留进程与会话（中断不是销毁）。
        if (cancelled) {
          this.#scheduleCancelGrace(link, turn)
          this.#wakeAccessWaiters()
          return
        }
        // 让本次入站权限/fs 请求先完成拒绝响应，再拆连接；下一回合必须等回收。
        this.#scheduleRecycle(link)
        this.#wakeAccessWaiters()
      },
      onBridgePermission: (tool) => this.#log?.info(
        `antigravity-acp: 已允许私有 MCP 桥单次调用 tool=${tool}；执行与审批仍由 DSH 负责，复用当前 ACP prompt`,
      ),
      onArgumentIssues: (info) =>
        this.#log?.warn(
          `antigravity-acp: 转交的工具调用参数与 schema 不符 tool=${info.tool}` +
            `（缺少必填=[${info.missing.join(',')}] 未声明键=${info.unknownCount}个[${info.unknown.join(',')}]；仅键名，入桥后修正别名并预检）`,
        ),
      onConfigOptions: (observed) => this.observeSessionConfigOptions(observed),
      onPermissionDiagnostic: (diagnostic) =>
        this.#log?.warn(`antigravity-acp: 权限请求结构（仅诊断，不代表授权） ${JSON.stringify(diagnostic)}`),
      onNativeRefusal: (info) =>
        this.#log?.warn(
          `antigravity-acp: 已拒绝${info.kind === 'permission' ? ' ACP 工具权限申请' : '原生客户端请求'}` +
            `（${info.detail}，本回合第 ${info.count} 次；来源=ACP插件，尚未转交DSH工具审批）`,
        ),
    })
    this.#turn = turn
    if (key === undefined) this.#ephemeral.set(turn, link)
    this.#subscribeTurn(turn)
    // 回合生命周期打点：选具体型号后「没有反应」这类问题，只靠这条能分清是
    // 「prompt 没送出去」「送出去了但没有块回来」还是「块回来了但没被消费」。
    this.#log?.info(
      `antigravity-acp: 回合开始 model=${options.model} purpose=${options.purpose ?? 'chat'} session=${sessionId} tools=${tools.length}` +
        `${options.reasoningEffort === undefined ? '' : ` effort=${String(options.reasoningEffort)}`}` +
        `${reused ? ' reused=true' : ''}`,
    )
    // 复用会话只发增量；否则全量重建（含 system、工具策略与历史强调块）。
    let content: Awaited<ReturnType<typeof buildPromptWithImages>>
    try {
      // system 已经通过 session/new 的 meta 交给 agent 时，prompt 里不再重复包装。
      const systemBlock = this.#systemViaMeta.has(sessionId) ? undefined : options.system
      const promptMessages = replay ? boundedHistory(options.messages, this.#replayMaxChars) : options.messages
      content = reused
        ? await buildPromptDeltaWithImages(incrementalMessages(options.messages, reused.sentCount), this.#imageOptions(options.signal))
        : await buildPromptWithImages(systemBlock, promptMessages, tools, this.#imageOptions(options.signal))
    } catch (error) {
      // prompt 还没发出去就失败（图片不可用 / 被取消 / 内容不支持）：刚建立的
      // ACP 会话与磁盘 claim 必须当场回收，不能只靠空闲回收兜底。
      this.#bridge.invalidateRound('prompt 构造失败')
      this.#releaseTurnSubscription(turn)
      if (this.#turn === turn) this.#turn = undefined
      const ephemeral = this.#ephemeral.get(turn)
      if (ephemeral) {
        this.#ephemeral.delete(turn)
        this.#closeSession(ephemeral, turn.sessionId)
      }
      if (reused) this.#dropSession(reused, 'prompt 构造失败')
      else if (key !== undefined) this.#sessionStore?.unclaim(key, this.#sessionOwner)
      this.#lifecycle?.failed(error)
      throw error
    }
    this.#lifecycle?.promptSent()
    // 新会话先把「已发送」记到本轮完整历史，之后才有资格复用。
    const record = reused ?? (key !== undefined
      ? this.#rememberSession(options, key, link, sessionId)
      : undefined)
    // 在新 prompt 在途期间，不把上一轮的旧游标继续当作可恢复状态。
    if (record) {
      this.#sessionStore?.delete(record.key, this.#sessionOwner)
      if (this.#sessionStore) await withAbort(this.#sessionStore.flush(), options.signal)
    }
    if (this.#disposed) {
      turn.abort('adapter 已卸载')
      throw new LlmError('Antigravity ACP adapter 已卸载', 'AGY_LINK_CLOSED')
    }
    turn.startPrompt(content, options.signal)
    try {
      let chunks = 0
      let textChars = 0
      let reasoningChars = 0
      let finish = ''
      const emitted: ContentBlock[] = []
      for await (const chunk of drainTurn(turn)) {
        if (chunk.type === 'text-delta') textChars += chunk.text.length
        if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        if (chunk.type === 'block-end') emitted.push(structuredClone(chunk.block))
        if (chunk.type === 'finish') {
          finish = chunk.reason.kind
          if (record) this.#advanceSession(record, options, emitted, turn.promptSettled)
        }
        if (chunks === 0) this.#log?.info(`antigravity-acp: 回合首块到达（type=${chunk.type}）`)
        if (chunk.type !== 'finish') this.#lifecycle?.firstOutput(chunk.type === 'block-end' && chunk.block.type === 'tool-call')
        else this.#lifecycle?.finish(chunk.reason.kind)
        chunks += 1
        yield chunk
      }
      this.#log?.info(
        `antigravity-acp: 回合结束 model=${options.model} purpose=${options.purpose ?? 'chat'}` +
          ` 块数=${chunks} textChars=${textChars} reasoningChars=${reasoningChars} finish=${finish}`,
      )
      const timing = this.#lifecycle?.read().round
      if (timing) this.#log?.info(`antigravity-acp: 回合计时 elapsedMs=${Math.round(timing.elapsedMs)} firstChunkMs=${timing.firstChunkMs === undefined ? '-' : Math.round(timing.firstChunkMs)} firstToolMs=${timing.firstToolMs === undefined ? '-' : Math.round(timing.firstToolMs)} setup=${JSON.stringify(timing.timings)}`)
    } catch (error) {
      this.#log?.warn(`antigravity-acp: 回合失败 model=${options.model}`, error)
      if (record) this.#dropSession(record, '回合异常')
      throw error
    } finally {
      // 只有该 ACP prompt **真正结束**（已应答且不再等待回喂）才退订；
      // finish(tool-calls) 之后 prompt 还活着，订阅必须留给续轮。
      this.#releaseTurnSubscriptionIfClosed(turn)
    }
  }

  async *#runContinuation(
    turn: PromptTurn,
    options: GenerateOptions,
    tail: readonly RequestMessage[],
    note?: string,
  ): AsyncGenerator<StreamChunk> {
    this.#bridge.publishTools(options.tools ?? [])
    if (turn.terminated) {
      // 终止的回合不会再有生产者。必须**先于 resume()** 判定：resume 会把
      // producerDone 复位，之后 drainTurn 会因无人生产而永久挂起。
      yield { type: 'finish', reason: { kind: 'aborted', failure: {
        code: AGY_TURN_ERROR.ABORTED, message: '续轮目标回合已被终止，按取消处理',
      } } }
      return
    }
    turn.resume(options.signal)
    this.#lifecycle?.continuing()
    // 续轮仍在同一个 ACP prompt 内：先确保 park 订阅在位——回喂之后 agent
    // 可能马上发起第二批 tools/call，若此处没有订阅，那些 MCP 请求会永久挂起。
    // 同回合重复调用是幂等的，不会叠加监听器。
    this.#subscribeTurn(turn)
    const results: BridgeToolResult[] = await Promise.all(tail.map(async (message) => {
      if (message.role !== 'tool') throw new LlmError('续轮内部错误：非 tool 角色进入工具回喂', AGY_ADAPTER_ERROR.BUSY)
      return {
        callId: message.toolCallId,
        text: '',
        content: await buildToolResultContent(message.content, this.#imageOptions(options.signal)),
        isError: message.isError === true,
      }
    }))
    if (note !== undefined && results.length > 0) {
      // 续轮不重发 prompt，也没有第二个 ACP prompt 承载「宿主通知 / 用户
      // 插话」；附到最后一条工具结果里交给 agent（内容一次性、只发一次）。
      const last = results[results.length - 1]!
      last.content = [...(last.content ?? []), { type: 'text', text: note }]
    }
    try {
      // 续轮不重发 prompt：结果交给桥 resolve 上轮 park 的 MCP 调用，agent 在
      // **同一个 ACP prompt** 内继续产出后续 session/update。
      try {
        await turn.deliverToolResults(results)
      } catch (error) {
        // 回喂期间回合被并发终止（如权限拒绝超限触发 resetPending）时，回合自身
        // 的失败才是主因：改为 drain 出它的 finish，而不是让回喂的次要错误
        // （AGY_NO_PENDING_TOOL_CALL）掩盖原始失败。
        if (!turn.terminated) throw error
      }
      const emitted: ContentBlock[] = []
      for await (const chunk of drainTurn(turn)) {
        if (chunk.type === 'block-end') emitted.push(structuredClone(chunk.block))
        if (chunk.type === 'finish') {
          const key = reusableSessionKey(options)
          const record = key === undefined ? undefined : this.#sessions.get(key)
          if (record?.sessionId === turn.sessionId) this.#advanceSession(record, options, emitted, turn.promptSettled)
        }
        if (chunk.type !== 'finish') this.#lifecycle?.firstOutput(chunk.type === 'block-end' && chunk.block.type === 'tool-call')
        else this.#lifecycle?.finish(chunk.reason.kind)
        yield chunk
      }
    } finally {
      // 续轮带来的 assistant/tool 消息已经在 ACP 会话里体现过：成功时推进游标，
      // 让下一次用户轮只发送真正的新消息；回合被终止则作废该会话。
      if (turn.terminated) this.#dropSessionsForTurn(turn.sessionId, '续轮目标回合已终止')
      this.#releaseTurnSubscriptionIfClosed(turn)
    }
  }

  /**
   * 确保该回合已订阅桥的 park 事件（幂等）。订阅按**回合**建立：一次 stream
   * 调用的结束不等于 ACP prompt 的结束，而 park 可能在任何时刻到达。
   */
  #subscribeTurn(turn: PromptTurn): void {
    if (this.#turnSubscription?.turn === turn) return
    this.#releaseTurnSubscription()
    this.#turnSubscription = {
      turn,
      unsubscribe: this.#bridge.onParked((call) => turn.handleParked(call)),
    }
  }

  /** 释放 park 订阅；给了 turn 时只释放属于该回合的那一条。幂等。 */
  #releaseTurnSubscription(turn?: PromptTurn): void {
    const subscription = this.#turnSubscription
    if (!subscription) return
    if (turn && subscription.turn !== turn) return
    this.#turnSubscription = undefined
    subscription.unsubscribe()
  }

  /** 回合已收尾（prompt 已应答且不再等待回喂）时才退订。 */
  #releaseTurnSubscriptionIfClosed(turn: PromptTurn): void {
    if (!this.#isTurnClosed(turn)) return
    this.#releaseTurnSubscription(turn)
    const link = this.#ephemeral.get(turn)
    if (link) {
      this.#ephemeral.delete(turn)
      this.#closeSession(link, turn.sessionId)
    }
    // 复用会话时不做 invalidateRound：轮换 token 会让 agent 手里的 MCP 连接立即失效。
  }

  /** 放弃当前回合：取消 ACP 会话、封口 chunk 队列、清空 bridge 的 park。 */
  #abandonTurn(reason: string): void {
    const turn = this.#turn
    this.#turn = undefined
    this.#releaseTurnSubscription(turn)
    if (!turn) return
    if (!turn.promptSettled) void turn.abort(reason)
    turn.finishRound()
    turn.dispose()
    this.#bridge.resetPending(reason)
    // 用户取消（想改提示词再发）不是「会话不可信」：保留会话与映射，
    // 下一轮优先 session/resume 接回（真机验证：cancelled 的会话仍可 resume）。
    const record = [...this.#sessions.values()].find((item) => item.sessionId === turn.sessionId)
    const keepForCancel = record !== undefined && record.cancelled === true
    if (!keepForCancel) this.#dropSessionsForTurn(turn.sessionId, reason)
    else this.#log?.info(`antigravity-acp: 取消后保留 ACP 会话 session=${turn.sessionId}（${reason}）`)
    this.#releaseTurnSubscriptionIfClosed(turn)
  }

  #isTurnClosed(turn: PromptTurn): boolean {
    // finished 的判定：回合已结束且不再等待工具结果。
    return turn.terminated || (turn.promptSettled && !turn.awaitingToolResults)
  }

  #handleUnexpectedRequest(method: string, _request: AnyRequest): void {
    if (this.#disposed || !this.#turn) return
    const params = _request.params as { sessionId?: unknown } | undefined
    if (params?.sessionId !== undefined && params.sessionId !== this.#turn.sessionId) return
    this.#turn.handleUnexpectedAgentRequest(method)
  }

  /**
   * 从 `usage_update` 观察上下文容量：ACP 对 `size` 的定义是
   * 「Total context window size in tokens」，正好填 `LlmResolvedModelInfo.context`。
   * 归属到当前回合的 DSH 路由键（`#routeModelId`）；只认正的有限数。
   */
  #observeUsageUpdate(notification: SessionNotification): void {
    const update = notification.update
    if (update.sessionUpdate !== 'usage_update') return
    // 只认当前回合的 ACP 会话：被放弃的旧会话仍可能继续发通知，不能把它的
    // 容量记到新回合的路由键上。
    const turn = this.#turn
    if (!turn || turn.terminated || notification.sessionId !== turn.sessionId) return
    // 上下文已用量：这是宿主上下文占用**唯一**的样本来源（ACP 的
    // `PromptResponse.usage` 是本回合内多次内部调用的求和，当占用会按调用次数
    // 放大成数倍窗口）。
    // 超出窗口的值说明上游计数不可信，按窗口夹住，避免宿主直接显示 100%。
    const size = update.size
    const used = update.used
    if (typeof used === 'number' && Number.isFinite(used) && used > 0) {
      const ceiling = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : undefined
      turn.noteUsage({ inputTokens: ceiling === undefined ? used : Math.min(used, ceiling), outputTokens: 0 })
    }

    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return
    const model = this.#routeModelId
    if (!model) return
    if (this.#contextWindows.get(model) === size) return
    this.#contextWindows.set(model, size)
    this.#onMetadataChanged?.(this.exportMetadata())
    // 容量随目录一起落盘，重启后压缩引擎不必等下一次 usage_update。
    this.#persistCatalog()
  }

  /**
   * 记一条实测容量，并同时挂到它的家族 id 上。
   *
   * `usage_update` 归属的是 DSH 路由键（家族 id），而目录/缓存里的条目是 ACP
   * 的档位 id；两个 key 都写，落盘与重启后读回才能对得上。
   */
  #rememberContextWindow(id: string, size: number): void {
    this.#contextWindows.set(id, size)
    const family = modelFamilyId(id)
    if (family !== id && this.#contextWindows.get(family) === undefined) {
      this.#contextWindows.set(family, size)
    }
  }

  /**
   * 观察一次 ACP 会话配置：刷新模型目录缓存、model 选择器与思考强度选择器。
   * `session/new`、`session/set_config_option` 与 `config_option_update` 共用。
   */
  observeSessionConfigOptions(configOptions: readonly SessionConfigOption[] | null | undefined): void {
    ++this.#catalogFoldGeneration
    const selector = findModelSelector(configOptions)
    const thought = findThoughtLevelSelector(configOptions)
    this.#catalogObserved = true
    // session/new 与 session/resume 允许省略 configOptions。一次不完整观测
    // 不能抹掉已知目录或选择器，否则后续会话会无故失去模型路由能力。
    let changed = false
    if (selector) {
      this.#modelSelector = selector
      this.#catalog = toModelCatalog(AGY_PROVIDER_ID, selector)
      this.#catalogSource = 'acp'
      changed = true
    }
    // 档位选择器的 options 随当前模型变化（Hydrogen 多一档 xhigh），每次观测都
    // 整体替换；agent 没声明 `thought_level` 时保留上一次的，让旧协议路径继续可用。
    if (thought) {
      this.#thoughtLevel = thought
      // 把 agent 真实声明的档位名并进旧协议的后缀识别集合：这样「有哪些档位」
      // 以 agent 为准，官方新增档位不需要改客户端代码。
      registerTierSuffix(thought.options.map((option) => option.value))
      changed = true
    }
    if (changed) this.#onMetadataChanged?.(this.exportMetadata())
    // 观测到真实目录后缓存不再参与 listModels，避免配置变更后仍读到旧磁盘目录。
    this.#cacheLoad = undefined
    // 真实目录只在会话建立后才能观测到；落盘后重启不必退化成占位模型。
    // 写入失败与并发写冲突都无所谓：缓存是优化，不是功能。
    if (selector) this.#persistCatalog()
  }

  /** 把当前目录（含实测上下文容量）与档位选择器落盘；写失败不影响功能。 */
  #persistCatalog(): void {
    if (!this.#saveCatalog || this.#catalog.length === 0) return
    const payload: CachedCatalog = {
      models: this.#catalog.map((model) => {
        // `usage_update` 归属的是 DSH 路由键（家族 id），而目录条目是 ACP 的档位
        // id；按家族 id 兜底查询，否则折叠目录永远落盘不到 contextWindow。
        const contextWindow = this.#contextWindows.get(model.id)
          ?? this.#contextWindows.get(modelFamilyId(model.id))
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
        }
      }),
      ...(this.#thoughtLevelSnapshot() === undefined ? {} : { thoughtLevel: this.#thoughtLevelSnapshot() }),
    }
    void Promise.resolve().then(() => this.#saveCatalog?.(payload)).catch(() => undefined)
  }

  /** 是否已经从真实 ACP 会话观测到过配置（listModels 空目录时的诊断依据）。 */
  get catalogObserved(): boolean {
    return this.#catalogObserved
  }

  /**
   * 把 DSH 选定的模型与思考强度写进 ACP 会话配置。
   *
   * ACP v1 的 `session/set_config_option` 需要既有 sessionId，因此顺序是
   * `session/new` → `set_config_option` → `session/prompt`（initialize 响应
   * 不携带 configOptions，没有「new 之前设置」的通道）。
   *
   * 两条路径，按 agent 能力选择：
   * 1. **agent 声明了 `thought_level`**（ACP 1.5+，官方 1.5.10 实测）：模型只发
   *    家族 id（`claude-opus-5-5`），档位单独写进 `thought_level`。请求的档位不在
   *    agent 声明的选项里时按 low→high 就近收敛，不把未知值发出去。
   * 2. **旧 agent 没有独立档位通道**：档位被编进模型 id，发
   *    `claude-opus-5-5-high` 这样的档位 id（官方仍在解析这种旧值）。
   *
   * 设置页的官方模型 ID 映射（`modelOverrides[id].target`）在两条路径下都优先。
   */
  async #applyModelSelection(
    link: AgentLink,
    sessionId: string,
    model: string,
    effort?: { toString(): string },
    signal?: AbortSignal,
  ): Promise<void> {
    // 档位表可能尚未建立（API 直调时选择器还没列过目录）：先折叠一次再路由。
    await withAbort(this.#foldCatalog(AGY_PROVIDER_ID), signal)
    throwIfAborted(signal)
    const settings = this.#modelSettingsSnapshot()
    // 旧会话的占位路由：只按显式映射处理，没有映射就沿用官方会话默认模型。
    if (model === AGY_PLACEHOLDER_MODEL_ID && modelSettingFor(settings, model).target === undefined) return
    const selector = this.#modelSelector
    if (!selector) {
      throw new LlmError(
        'Antigravity ACP 会话未声明任何 model 类配置选项（select + category/name 匹配 model），无法为该 provider 选择模型',
        AGY_ADAPTER_ERROR.NO_MODEL_SELECTOR,
      )
    }
    const family = modelFamilyId(model)
    const pinnedTier = tierForModelId(model)
    const effortId = normalizeEffort(effort) ?? pinnedTier
    const thought = this.#thoughtLevel
    const tiers = this.#familyTiers.get(family)
    const target = modelSettingFor(settings, model).target
    const modelValue = resolveModelTarget({
      settings,
      model,
      effort: effortId,
      route: (tier) => {
        // 有独立档位通道时模型只发家族 id；若模型 id 本身就是旧会话钉住的档位 id，
        // 也折回家族，档位交给 thought_level。
        if (thought) return family
        const legacyTier = tier === undefined ? undefined : AGY_REASONING_EFFORTS.find((candidate) => candidate === tier)
        return legacyTier !== undefined
          ? routeTieredModelId(family, legacyTier, tiers)
          : pinnedTier !== undefined
            ? model
            : tiers !== undefined && tiers.size > 0
              ? routeTieredModelId(family, DEFAULT_AGY_REASONING_EFFORT, tiers)
              : family
      },
    })
    // 两种短路都只认本会话自己的证据：已确认写入过的值，或本会话建立时自己
    // 声明的选择器当前值。连接级选择器可能来自别的会话，不能用。
    const modelSettled = this.#sessionModelValues.get(sessionId) === modelValue
      || (this.#sessionModelDeclared.has(sessionId) && selector.currentValue === modelValue)
    if (!modelSettled) {
      // 自诊断：把路由结果落进宿主日志（模型选择出问题时，这是唯一能看到「DSH
      // 给的 id → 我们发出去的 configId/value」的地方）。
      this.#log?.info(
        `antigravity-acp: 模型路由 dsh=${model} → configId=${selector.configId} value=${modelValue}` +
          `（family=${family}${effortId ? ` effort=${effortId}` : ''}${pinnedTier ? ' 档位已钉住' : ''}` +
          `${target === undefined ? '' : ' 已按映射改写'}${thought ? ' 档位走 thought_level' : ''}）`,
      )
      // 目录成员资格按 dsh-llm 语义是建议性的：未登记的 id 仍然照发，由 ACP
      // agent 自己判定是否接受，而不是在这里静默改写成别的模型。
      const response = await this.#setConfigOption(link, sessionId, selector.configId, modelValue, signal)
      // RPC 成功即接受选模；服务端可归一化模型 ID，不再额外要求回显逐字一致。
      this.#rememberSessionModelValue(sessionId, modelValue)
      if (response.configOptions?.length) this.observeSessionConfigOptions(response.configOptions)
    }
    if (!thought) return
    // agent 可能在 set model 之后换了一套档位选项（Hydrogen 多一档 xhigh），
    // 所以用观测到的最新选项收敛，而不是选模那一刻的旧快照。
    const fresh = this.#thoughtLevel ?? thought
    const desired = effortId === undefined ? undefined : clampEffort(effortId, fresh.options)
    if (desired === undefined) return
    if (effortId !== undefined && desired !== effortId) {
      this.#log?.info(
        `antigravity-acp: 模型 ${model} 未声明思考档位 ${effortId}，自动就近收敛到 ${desired}（可选：${fresh.options.map((o) => o.value).join('/')}）`,
      )
    }
    const settled = this.#sessionThoughtValues.get(sessionId) === desired
      || (this.#sessionModelDeclared.has(sessionId) && fresh.currentValue === desired)
    if (settled) return
    this.#log?.info(
      `antigravity-acp: 档位路由 dsh=${model} effort=${effortId} → configId=${fresh.configId} value=${desired}`,
    )
    const response = await this.#setConfigOption(link, sessionId, fresh.configId, desired, signal)
    this.#rememberSessionThoughtValue(sessionId, desired)
    if (response.configOptions?.length) this.observeSessionConfigOptions(response.configOptions)
  }

  /**
   * 应用配置的会话模式（如 `plan`）。
   *
   * 只提交 agent 在该会话里真正声明过的 mode id；没配置或没声明时保持 agent 默认，
   * 不猜、不改写。
   */
  async #applyAgentMode(
    link: AgentLink,
    sessionId: string,
    modes: { availableModes?: readonly { id: string }[] } | null | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const mode = this.#agentMode
    if (mode === '') return
    const declared = modes?.availableModes?.some((entry) => entry.id === mode) ?? false
    if (!declared) {
      this.#log?.warn(`antigravity-acp: 会话模式 ${mode} 未被 agent 声明，沿用默认模式`)
      return
    }
    try {
      await link.setMode({ sessionId, modeId: mode }, { signal })
      this.#log?.info(`antigravity-acp: 会话模式已设为 ${mode} session=${sessionId}`)
    } catch (error) {
      this.#log?.warn(`antigravity-acp: session/set_mode 失败（mode=${mode}）`, error)
    }
  }

  /** 写一个会话配置项；失败原因带 configId 落进宿主日志后再抛。 */
  async #setConfigOption(
    link: AgentLink,
    sessionId: string,
    configId: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<{ configOptions?: readonly SessionConfigOption[] }> {
    try {
      return await link.setConfigOption({ sessionId, configId, value }, { signal })
    } catch (error) {
      this.#log?.warn(`antigravity-acp: session/set_config_option 失败（configId=${configId} value=${value}）`, error)
      throw error
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmError('Antigravity ACP 请求已取消', AGY_TURN_ERROR.ABORTED)
}

/** 不丢失原 promise 的拒绝处理；取消只停止等待，资源所有者负责清理。 */
function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new LlmError('Antigravity ACP 请求已取消', AGY_TURN_ERROR.ABORTED))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    if (signal.aborted) onAbort()
  })
}

/** 把回合的 chunk 队列逐个交给调用方；undefined 表示本轮已取尽。 */
async function* drainTurn(turn: PromptTurn): AsyncGenerator<StreamChunk> {
  for (;;) {
    const chunk = await turn.nextChunk()
    if (chunk === undefined) return
    yield chunk
  }
}

/**
 * 按用途收紧等待上限：标题生成与压缩都是一次性请求，挂住会占住 worker 并拖慢
 * 聊天；给它们各自更短的上限，而不是沿用聊天的 30 分钟。
 */
function purposeTimeoutMs(purpose: string | undefined, fallback: number): number {
  if (purpose === 'session-title') return Math.min(fallback, 90_000)
  if (purpose === 'compaction') return Math.min(fallback, 600_000)
  return fallback
}

/**
 * 把 DSH 传来的思考强度归一到小写档位名；空值返回 undefined（沿用会话当前档位）。
 *
 * 这里**不收窄**到 low/medium/high：ACP 1.5 起档位由 agent 声明的
 * `thought_level` 选项决定，实测 Gemini 4 Hydrogen 还多一档 `xhigh`。合法性在
 * 真正写配置时按当时的选项收敛（见 `clampEffort`），而不是在入口猜。
 */
function normalizeEffort(effort?: { toString(): string }): string | undefined {
  const raw = effort === undefined ? undefined : effort.toString().trim().toLowerCase()
  return raw === undefined || raw === '' ? undefined : raw
}

/** 档位的强弱顺序，用于「请求的档位不在声明里」时就近收敛。 */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** CLI 目录里出现、但 agent 当前 `thought_level` 选项未必包含的档位的展示名。 */
const TIER_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: 'Extra' }

/** 档位在强弱顺序里的位置；未知值排在最后，不参与猜测。 */
function effortRank(id: string): number {
  const index = (EFFORT_ORDER as readonly string[]).indexOf(id)
  return index === -1 ? EFFORT_ORDER.length : index
}

/** ACP `thought_level` 选项 → 宿主的 reasoning 档位元数据。 */
function reasoningsFrom(
  options: readonly { value: string; name: string; description?: string | null }[],
): Array<{ id: ReturnType<typeof ReasoningEffortId>; name: string; description?: string }> {
  return options.map((option) => ({
    id: ReasoningEffortId(option.value),
    name: option.name,
    ...(option.description === undefined || option.description === null ? {} : { description: option.description }),
  }))
}

/**
 * 把请求的思考档位收敛到 agent 实际声明的选项：
 * - 完全匹配优先；
 * - 否则按 low→medium→high→xhigh→max 强弱顺序就近收敛（例如从 Hydrogen 的 xhigh
 *   切到只支持 low/medium/high 的 Argon/Neon 时自动收敛到 high，避免切模型后首轮报错）；
 * - 请求值不在已知强弱序里时退回 medium 或最后一项。
 */
export function clampEffort(requested: string, options: readonly { value: string }[]): string | undefined {
  const values = options.map((option) => option.value)
  if (values.length === 0) return undefined
  if (values.includes(requested)) return requested
  const wanted = (EFFORT_ORDER as readonly string[]).indexOf(requested)
  if (wanted !== -1) {
    let best: string | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const value of values) {
      const index = (EFFORT_ORDER as readonly string[]).indexOf(value)
      if (index === -1) continue
      const distance = Math.abs(index - wanted)
      if (distance < bestDistance || (distance === bestDistance && index > (EFFORT_ORDER as readonly string[]).indexOf(best ?? ''))) {
        best = value
        bestDistance = distance
      }
    }
    if (best !== undefined) return best
  }
  if (values.includes(DEFAULT_AGY_REASONING_EFFORT)) return DEFAULT_AGY_REASONING_EFFORT
  return values[values.length - 1]
}

/**
 * 不支持项检查。temperature / stop 没有 ACP 对应通道，记录警告并忽略。
 *
 * `reasoningEffort` **不是**不支持项：它现在是家族 → 档位模型的路由键
 * （2026-10-16 用户指示「菜单选择思考强度自动路由到对应模型」），见
 * `#applyModelSelection`。`maxTokens` 同样静默忽略（宿主会话标题等流程固定
 * 携带它，硬拒绝会让这些功能永久失败）。
 */
function unsupportedOptions(options: GenerateOptions): string[] {
  const unsupported: string[] = []
  if (options.temperature !== undefined) unsupported.push('temperature')
  if (options.stop !== undefined) unsupported.push('stop')
  return unsupported
}

/**
 * 取 messages 尾部连续的 tool 结果消息（按原顺序）。
 *
 * 会先跳过落在工具结果**之后**的未发送 user 消息：
 * - 宿主追加上下文（`time-context` 墙钟到期、`runtime-context`、技能目录、
 *   `tool-jobs` 后台任务通知……）；
 * - 用户在回合中途的插话（DSH `busyEnter: steer`）。
 *
 * DSH 的 pre-step 把它们追加到请求 `messages` 的最后一条；它们不是「上一步的
 * 模型输出」，不能因为它们排在末尾就判定「尾部没有工具结果」——那会让续轮
 * 假失败、进而丢弃 ACP 会话（真机实测：整轮 `AGY_SESSION_UNRECOVERABLE`）。
 *
 * 判定用 `ContinuationState.trimTrailingUnsentUser()`：`user` 角色且 id 从未
 * 发出去过。不枚举来源类型，新增来源自动生效。
 *
 * 注意：跳过的消息仍然留在 `options.messages` 里；续轮时由
 * `tailDeliveryNote()` 附到最后一条工具结果投递给 agent。
 */
function trailingToolResults(
  messages: readonly RequestMessage[],
  state?: ContinuationState,
): RequestMessage[] {
  const end = state === undefined ? messages.length - 1 : state.trimTrailingUnsentUser(messages).length - 1
  const tail: RequestMessage[] = []
  for (let index = end; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'tool') break
    tail.unshift(message)
  }
  return tail
}


/**
 * 续轮匹配：尾部 tool 结果与**仍在等待回喂**的 park 调用按 id 一一对应。
 * 并行工具的完成顺序可以与发起顺序不同。
 *
 * 只统计尚未回喂的 park：同一个 ACP prompt 内可以有多批工具调用，早先批次
 * 交付后仍留在 `parkedCalls` 里作为回合账本；若把它们一并计入长度比较，
 * 第二批之后的续轮永远匹配不上，会被迫放弃回合、重建会话。
 */
function matchesParkedCalls(turn: PromptTurn, tail: readonly RequestMessage[], bridge: McpToolBridge): boolean {
  if (tail.length === 0) return false
  const parked = turn.parkedCalls.filter((call) => bridge.hasPending(call.callId))
  if (parked.length !== tail.length) return false
  const remaining = new Set(parked.map((call) => call.callId))
  return tail.every((message) => message.role === 'tool' && remaining.delete(message.toolCallId))
}
