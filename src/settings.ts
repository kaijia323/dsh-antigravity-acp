/**
 * 插件配置接口与 schemastery Schema。
 * schema 写法对准已安装 @deepseek-ai/schemastery 3.18.x 的实际导出。
 */
import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { DEFAULT_ACP_SERVER_VERSION } from './runtime/binary.js'

/** 单个模型目录条目上的用户设置；键是 DSH 模型选择器里的模型 ID。 */
export interface ModelOverride {
  /** 是否出现在 DSH 模型选择器；省略等同启用。停用不删除目录条目，仍可被会话请求。 */
  enabled?: boolean
  /** 显示名覆盖；省略用官方目录名称。 */
  name?: string
  /** 映射到官方模型 ID，原样写入 ACP 会话，优先于家族 + 档位路由。 */
  target?: string
}

export interface AntigravityHostConfig {
  /** Maximum independent ACP workers, started on demand. */
  /** Maximum wait for an available worker. */
  /** 会话模式：agent 声明的 mode id（官方 1.5.10：default / accept-edits / auto / plan）。空串沿用默认。 */
  agentMode?: string
  /** Explicit official CLI path, re-detected for manual reads. */
  agyCliPath?: string
  /** 插件启用时提前启动 ACP 连接并保留给聊天使用；不发送模型消息。 */
  /** 官方 agy-acp-server 可执行文件路径；优先级高于 AGY_ACP_BIN 与自动下载。 */
  binaryPath?: string
  /** 未找到本地二进制时是否自动从 dl.google.com 下载（默认 true）。 */
  /** 传给 ACP server 的额外命令行参数。 */
  extraArgs?: string[]
  /** 自动下载的目标版本（默认 1.4.0）。 */
  acpVersion?: string
  /** 单个 ACP 请求默认超时（毫秒）。 */
  requestTimeoutMs?: number
  /** initialize 握手等待上限（毫秒）；官方进程冷启动可达 1 分钟。 */
  handshakeTimeoutMs?: number
  /**
   * authenticate（oauth-personal，需人工在浏览器完成授权）的等待上限（毫秒）。
   * 独立于 requestTimeoutMs，默认 5 分钟。
   */
  authTimeoutMs?: number
  /** 单轮 session/prompt 的等待上限（毫秒）；ACP 回合可能很长，默认 30 分钟。 */
  promptTimeoutMs?: number
  /**
   * session/new 与 session/resume 的请求上限（毫秒），默认 120 秒。
   * 与通用 requestTimeoutMs 分开：官方 agent 冷启动、同账号多 worker 并发时，
   * 30 秒内完成会话创建并不罕见（真机 2026-11-19 子代理 session/new 超时）。
   */
  sessionTimeoutMs?: number
  /** 并发 MCP tools/call 的聚合窗口（毫秒），决定同一轮携带多少 tool-call block。 */
  bridgeParkSettleMs?: number
  /**
   * 按模型 ID 的目录设置：是否出现在 DSH 模型选择器、显示名与官方模型 ID 映射。
   * 思考强度不在配置里：它是模型的元数据，由 ACP agent 的 `thought_level`
   * 独立选项声明（旧 agent 才退回「档位编进模型 id」的目录推断）。
   * 只作用于目录中已存在的条目，不新增自造模型。
   */
  modelOverrides?: Record<string, ModelOverride>
  /**
   * 官方进程出网代理（如 http://127.0.0.1:7890）。留空继承宿主代理，宿主未配置才直连；
   * 填入后同时注入大小写两套 *_PROXY 与 NO_PROXY。
   */
  proxyUrl?: string
  /**
   * 代理排除列表（逗号分隔）。localhost/127.0.0.1/::1 始终自动排除，
   * 因为私有 MCP 桥与 OAuth 回调都在 loopback 上。
   */
  proxyBypass?: string
  /**
   * 跨进程恢复 ACP 会话：插件/宿主重启后，若上次留下会话映射，用
   * `session/resume` 接回原会话；接不上（映射缺失/路由变化/无该能力）就直接
   * 报 `AGY_SESSION_UNRECOVERABLE`，**不重放历史**。
   */
  resumeSessions?: boolean
  /**
   * 用户取消（停止按钮）后等待 agent 确认停止的上限；确认了保留进程与会话，
   * 超时才回收。0 表示不等待、立即回收。
   */
  cancelGraceMs?: number
  /** 保留进程的最长空闲时间（毫秒），超时回收；0 表示不设上限。 */
  idleRecycleMs?: number
  /**
   * 会话接不上时是否允许有界历史重放兜底（默认 true）：用最近若干消息
   * 新建 ACP 会话继续对话。关闭则保持旧行为（直接报 AGY_SESSION_UNRECOVERABLE）。
   */
  replayFallback?: boolean
  /** 重放兜底的历史预算（字符数，默认 120000）。 */
  replayMaxChars?: number
  /**
   * 目录没有报告上下文容量时的兜底值（tokens，默认 1048576；0 表示不填）。
   *
   * 官方 ACP 目录只报告模型 id/名称，容量要等会话 `usage_update` 才能观测到；
   * 未观测过的模型（如 gemini-4-hydrogen）若不带容量，DSH 在「切换模型」时
   * 会因无法计算压缩目标而报 `MODEL_SWITCH_COMPACTION_FAILED`。这里给一个
   * 可配置的保守默认：Claude 家族封顶 200k，其余用该值。
   */
  defaultContextWindow?: number
  /**
   * 是否允许额度取数调用本机官方 agy CLI（默认关闭）。
   * 关闭时不 spawn agy：套餐额度走 Cloud Code Assist HTTP（读该账号 HOME 下
   * 的 CLI 登录态），AI Credits 不查询。
   * 开启后运行 `agy -p /usage` 与 `agy -p /credits`；未找到 CLI 时套餐额度
   * 回落 HTTP，AI Credits 报 `cli-unavailable`。
   */
  cliQuotaEnabled?: boolean
}

// Only fields owned by the custom settings card are live. Ordinary launch/pool
// configuration remains ordinary, so editing it still follows the host lifecycle.
export const LIVE_SETTING_KEYS = ['agentMode', 'modelOverrides', 'proxyUrl', 'proxyBypass', 'agyCliPath', 'resumeSessions', 'replayFallback', 'replayMaxChars', 'defaultContextWindow', 'cancelGraceMs', 'idleRecycleMs', 'cliQuotaEnabled'] as const
export type LiveSettingKey = typeof LIVE_SETTING_KEYS[number]
export type AntigravityPluginConfig = Omit<AntigravityHostConfig, LiveSettingKey> & {
  [K in LiveSettingKey]?: AntigravityHostConfig[K] | Volatile<AntigravityHostConfig[K]>
}

function readSetting(value: string | Volatile<string | undefined> | undefined): string | undefined
function readSetting(value: boolean | Volatile<boolean | undefined> | undefined): boolean | undefined
function readSetting(value: number | Volatile<number | undefined> | undefined): number | undefined
function readSetting(value: Record<string, ModelOverride> | Volatile<Record<string, ModelOverride> | undefined> | undefined): Record<string, ModelOverride> | undefined
function readSetting(value: string | boolean | number | Record<string, ModelOverride> | Volatile<string | boolean | number | Record<string, ModelOverride> | undefined> | undefined): string | boolean | number | Record<string, ModelOverride> | undefined {
  return typeof value === 'object' && value !== null && 'get' in value ? (value as Volatile<unknown>).get() as Record<string, ModelOverride> : value as string | boolean | number | Record<string, ModelOverride> | undefined
}

/** Keep references live; callers may spread this view to capture one operation. */
export function liveHostConfig(config: AntigravityPluginConfig): AntigravityHostConfig {
  return {
    ...config,
    get modelOverrides() { return readSetting(config.modelOverrides) },
    get proxyUrl() { return readSetting(config.proxyUrl) },
    get proxyBypass() { return readSetting(config.proxyBypass) },
    get agentMode() { return readSetting(config.agentMode) },
    get agyCliPath() { return readSetting(config.agyCliPath) },
    get resumeSessions() { return readSetting(config.resumeSessions) },
    get replayFallback() { return readSetting(config.replayFallback) },
    get replayMaxChars() { return readSetting(config.replayMaxChars) },
    get defaultContextWindow() { return readSetting(config.defaultContextWindow) },
    get cancelGraceMs() { return readSetting(config.cancelGraceMs) },
    get idleRecycleMs() { return readSetting(config.idleRecycleMs) },
    get cliQuotaEnabled() { return readSetting(config.cliQuotaEnabled) },
  }
}

/**
 * modelOverrides 的 schema。
 *
 * TS2742 规避：`Schema.dict` 的推断类型引用 schemastery 依赖的 cosmokit
 * `Dict`；npm ci 在版本分叉时会把 cosmokit 嵌套进
 * `@deepseek-ai/schemastery/node_modules`，导出类型无法命名该路径（本机
 * 扁平提升才看不出来）。末尾的显式标注把 Config 的类型收敛到本包
 * `ModelOverride`，只经过可移植路径。
 */
const ModelOverrideSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('是否出现在 DSH 模型选择器'),
  name: Schema.string().description('显示名覆盖'),
  target: Schema.string().description('映射到的官方模型 ID，优先于家族 + 档位路由'),
})

export const Config = Schema.object({
  agentMode: Schema.string().volatile().description('会话模式（agent 声明的 mode id，如 plan）；留空沿用 agent 默认，只影响新建或恢复的会话'),
  agyCliPath: Schema.string().volatile().description('官方 agy CLI 路径；留空依次查 AGY_CLI_BIN、PATH 和默认安装目录'),
  binaryPath: Schema.string().description('官方 agy-acp-server 可执行文件路径；留空按 AGY_ACP_BIN → 缓存目录解析，找不到就报错（不自动下载）'),
  extraArgs: Schema.array(Schema.string()).default([]).description('传给 ACP server 的额外命令行参数'),
  acpVersion: Schema.string().default(DEFAULT_ACP_SERVER_VERSION).description('期望的 ACP server 版本；用于匹配缓存目录与目录缓存，不触发下载'),
  requestTimeoutMs: Schema.natural().default(30_000).description('单个 ACP 请求默认超时（毫秒）'),
  handshakeTimeoutMs: Schema.natural().min(1000).default(120_000).description('initialize 握手等待上限（毫秒）；官方进程冷启动（解压、杀软扫描）可能超过 1 分钟'),
  authTimeoutMs: Schema.natural().default(300_000).description('authenticate（需人工在浏览器完成 OAuth 授权）的等待上限（毫秒）'),
  promptTimeoutMs: Schema.natural().default(1_800_000).description('单轮 session/prompt 的等待上限（毫秒）'),
  sessionTimeoutMs: Schema.natural().min(1000).default(120_000).description('session/new 与 session/resume 的请求上限（毫秒）；默认 120 秒，官方 agent 冷启动 / 多 worker 并发时 30 秒默认值不够'),
  bridgeParkSettleMs: Schema.natural().default(50).description('并发 MCP tools/call 的聚合窗口（毫秒）'),
  modelOverrides: Schema.dict(ModelOverrideSchema).default({}).volatile().description('按模型 ID 的目录设置（是否显示、显示名、官方模型 ID 映射）；只作用于目录中已存在的模型') as Schema<
    Record<string, ModelOverride>,
    Record<string, ModelOverride>,
    'volatile-defined'
  >,
  proxyUrl: Schema.string().volatile().description('官方进程出网代理，如 http://127.0.0.1:7890（缺 scheme 按 http 处理）。留空继承宿主代理，宿主也未配置时才直连'),
  proxyBypass: Schema.string().volatile().description('代理排除列表，逗号分隔，如 example.internal,*.internal；不支持 CIDR。localhost/127.0.0.1/::1 始终自动排除'),
  resumeSessions: Schema.boolean().default(true).volatile().description('重启后用 session/resume 接上原 ACP 会话（唯一延续路径）；关掉它等于禁止历史会话跨进程继续。接不上时按 replayFallback 决定重放兜底或报错'),
  replayFallback: Schema.boolean().default(true).volatile().description('会话无法接上时用最近历史重放新建 ACP 会话，避免对话永久失效；关闭则直接报 AGY_SESSION_UNRECOVERABLE'),
  replayMaxChars: Schema.natural().min(1_000).max(2_000_000).default(120_000).volatile().description('重放兜底的历史预算（字符数）'),
  defaultContextWindow: Schema.natural().min(0).max(10_000_000).default(1_048_576).volatile().description('目录未报告容量时的兜底上下文窗口（tokens，0=不填）；Claude 家族封顶 200k。用于避免切换模型时 MODEL_SWITCH_COMPACTION_FAILED'),
  cancelGraceMs: Schema.natural().max(60_000).default(30_000).volatile().description('取消后等待 agent 确认停止的上限（毫秒）；0 表示不等待、立即回收'),
  idleRecycleMs: Schema.natural().max(3_600_000).default(900_000).volatile().description('空闲 worker 保留多久（毫秒）；默认 15 分钟后回收进程，下次进入该对话用 session/resume 接回（已验证不重放历史）。0 表示不回收'),
  cliQuotaEnabled: Schema.boolean().default(false).volatile().description('允许额度取数调用本机 agy CLI（默认关闭）。关闭时不启动 agy，套餐额度走内置直连，AI Credits 不查询。开启后运行 agy -p /usage 与 agy -p /credits；未找到 CLI 时套餐额度回落直连'),
})
