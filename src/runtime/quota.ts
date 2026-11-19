/**
 * Antigravity 套餐额度取数（Cloud Code Assist quota summary）。
 *
 * 数据面（用户 2026-10-16 明确选择 A 方案，放宽「bundle 不读 OAuth 凭据」约束）：
 * 1. 读官方 CLI 登录态 `~/.gemini/antigravity-cli/antigravity-oauth-token`；
 * 2. access token 过期时用其中的 refresh_token 向 Google OAuth token 端点换新
 *    （client 元数据：AGY_OAUTH_CLIENT_ID/SECRET → 本机官方分发物 → 已审计 client）；
 * 3. 调用 Cloud Code Assist 的 `loadCodeAssist` → `retrieveUserQuotaSummary`。
 *
 * 边界（保持克制）：
 * - **只读凭据，绝不写回**：刷新出的 access token 只在内存里用，不改官方登录文件；
 * - **client 元数据不编造**：只取真实存在的一份（环境变量 / 本机官方分发物 / auth-core
 *   里已审计的 Antigravity client），按「id 与 secret 出自同一 client」配对；分发物按
 *   分块扫描——1.5.x 的 Linux ACP server 已达 714MB，超过 V8 单字符串上限（约 512MB），
 *   整文件读成字符串会抛 `Invalid string length`；
 * - 任何错误消息在进入快照/日志前都过 `redactSensitiveText`，token 材料一律不出现在
 *   返回值、错误文本与诊断里；
 * - 失败不抛穿线，而是返回 `status: 'error'` 的快照，让 UI 显示可读原因。
 *
 * API 形态取自官方协议与公开实现的**事实**（端点、字段名、0..1 的
 * remainingFraction），代码为本项目原创实现。
 */
import { open, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  buildAntigravityHarnessBootstrapHeaders,
} from '@cortexkit/antigravity-auth-core'
import { redactSensitiveText } from './redact.js'
import { resolveInstallRoot, versionCachePaths, DEFAULT_ACP_SERVER_VERSION } from './binary.js'
import { agyCliCandidates } from './agy-cli.js'

/** Cloud Code Assist 内部端点前缀（方法以 `:method` 拼接，POST JSON）。 */
export const CODE_ASSIST_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal'
/** Google OAuth 2.0 token 端点（换发 access token）。 */
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** 官方 CLI 登录态文件（只读）。 */
export const TOKEN_SUBPATH = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'] as const

/** 提前多少毫秒视为「将过期」并触发换发。 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000
/** 额度快照的内存缓存时长（毫秒）。 */
export const QUOTA_CACHE_MS = 300_000
/**
 * 单次 HTTP 取数（换发 token 与 Cloud Code Assist 请求）的上限（毫秒）。
 *
 * 缺这条会让「代理不通 / 网络挂起」变成永久失败：`quota-remote` 把并发的
 * `read()` 合并到同一个在途 promise 上，挂死的请求会让额度药丸一直停在
 * 「读取中」，连手动刷新也救不回来（它只是在等同一个 promise）。
 */
export const QUOTA_HTTP_TIMEOUT_MS = 20_000

export type QuotaErrorCode =
  | 'token-missing'
  | 'token-expired'
  /** 历史错误码：client 元数据不可得。现在总会回落到已审计 client，不再产生。 */
  | 'refresh-unavailable'
  | 'refresh-failed'
  | 'request-failed'
  | 'bad-response'

/** 一个额度窗口（如「5 小时」「每周」）。 */
export interface QuotaBucket {
  name: string
  description?: string
  /** 窗口语义标识（官方字段 window，如 `5h`）。 */
  window?: string
  /** 剩余比例，0..1；官方未报告时缺省。 */
  remainingFraction?: number
  /** 剩余百分比（remainingFraction * 100，两位小数）。 */
  remainingPct?: number
  /** 配额重置时间（ISO 8601）。 */
  resetTime?: string
  disabled: boolean
}

/** 一组额度（如「Gemini 模型」组）。 */
export interface QuotaGroup {
  name: string
  description?: string
  buckets: QuotaBucket[]
}

/** 官方 AI Credits 独立快照；未知或失败绝不伪装成零余额。 */
export interface CreditsSnapshot {
  status: 'ok' | 'unavailable' | 'error'
  updatedAt: string
  remainingCredits?: number
  planName?: string
  stale?: boolean
  staleReason?: string
  error?: { code: 'cli-disabled' | 'cli-unavailable' | 'no-credit-info' | 'unsupported' | 'request-failed' | 'bad-response'; message: string }
}

/** 额度快照：成功带 groups/plan，失败带 error；credits 有独立状态。 */
export interface QuotaSnapshot {
  status: 'ok' | 'error'
  /** 取数时间（ISO 8601）。 */
  updatedAt: string
  /** 本次刷新失败，展示的是上一次成功的数据（`staleReason` 说明失败原因）。 */
  stale?: boolean
  staleReason?: string
  /** 订阅档位名（loadCodeAssist 的 paidTier/currentTier.name）。 */
  plan?: string
  groups: QuotaGroup[]
  /** 药丸请求中的公开模型与实际路由模型；仅用于选择对应额度组。 */
  requestedModel?: string
  routeModel?: string
  credits?: CreditsSnapshot
  error?: { code: QuotaErrorCode; message: string }
}

/** 登录态文件里我们只认这几项，其余（id_token 等）一律不读不用。 */
export interface QuotaTokenState {
  accessToken?: string
  refreshToken?: string
  expiry?: string
}

/** client 元数据来源：环境变量 / 本机官方分发物 / 插件内置已审计 client。 */
export type OAuthClientSource = 'env' | 'binary' | 'audited'

/** OAuth 客户端元数据（官方安装型客户端的公开标识，不是用户凭据）。 */
export interface OAuthClientMeta {
  clientId: string
  clientSecret: string
  /** 元数据来源；换发被拒时用来给可行动提示。 */
  source?: OAuthClientSource
}

/** 取数依赖面：全部可注入，测试用假实现，不碰真实网络与真实凭据。 */
export interface QuotaDeps {
  fetchImpl?: typeof fetch
  /** 读文本文件（官方登录态）；测试注入用。 */
  readFileImpl?: (path: string) => Promise<string>
  /** 官方二进制的分块文本流（测试注入用）；缺省直接分块读文件。 */
  binaryChunkStreamImpl?: (path: string) => AsyncIterable<string>
  env?: Readonly<Record<string, string | undefined>>
  now?: () => number
  /** 账号 HOME（读登录态用；多账号下会被覆盖成隔离账号的 HOME）。 */
  homedir?: () => string
  /** 用户级 HOME（安装根/缓存用）；缺省为操作系统的真实 homedir，不随账号隔离移动。 */
  systemHomedir?: () => string
  /** 可执行文件安装根；与模型/额度数据分开。 */
  installRoot?: string
  /** 设置中显式选择的官方 CLI 路径，优先于环境变量和 PATH。 */
  cliPath?: string
  /** 候选官方二进制路径（用于提取 OAuth client 元数据）。 */
  binaryPaths?: readonly string[]
  /**
   * 目标 ACP server 版本（用于在缓存目录里定位已解压的官方二进制）。
   * 缺省为 {@link DEFAULT_ACP_SERVER_VERSION}。
   */
  acpVersion?: string
  baseUrl?: string
  tokenUrl?: string
  /** 单次 HTTP 请求上限（毫秒）；缺省 {@link QUOTA_HTTP_TIMEOUT_MS}。 */
  httpTimeoutMs?: number
}

function defaultReadFile(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/**
 * 官方二进制分块扫描的块大小（字节）：远小于 V8 单字符串上限（约 512MB），
 * 714MB 级分发物也不会撞上限。
 */
const BINARY_SCAN_CHUNK_BYTES = 8 * 1024 * 1024
/**
 * 块间保留的重叠字符数：client id 最长 70 余字符、secret 35 字符，留足余量
 * 保证跨块边界的 id/secret 仍能命中。
 */
const BINARY_SCAN_OVERLAP_CHARS = 256

/**
 * 本次请求实际生效的超时（毫秒）。非正数视为「未设置」并回落到默认值。
 *
 * 不做「传 0 就等于关掉超时」的开关：关掉后并发 read() 又会合并到一个挂死的
 * 在途 promise 上，额度药丸永久停在读取中——那正是这条超时要修的故障。
 */
function effectiveTimeoutMs(deps: QuotaDeps): number {
  const configured = deps.httpTimeoutMs
  return configured !== undefined && configured > 0 ? configured : QUOTA_HTTP_TIMEOUT_MS
}

/**
 * 取数请求的超时信号。宿主 Node 都带 `AbortSignal.timeout`；测试环境的
 * fetch 替身不接信号时也不会受影响（它自己立即返回）。
 */
function timeoutSignal(deps: QuotaDeps): AbortSignal {
  return AbortSignal.timeout(effectiveTimeoutMs(deps))
}

/** 毫秒转人类可读时长：不足 1 秒时保留毫秒，避免出现「超过 0 秒」。 */
function formatTimeout(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 1_000)} 秒` : `${ms} 毫秒`
}

/** 超时与网络异常都归一成可读文本；不含请求 URL（可能带 userinfo）。 */
function describeRequestError(method: string, error: unknown, deps: QuotaDeps): string {
  // `AbortSignal.timeout()` 抛的是 TimeoutError；AbortError 则可能来自调用方主动
  // 取消。两者都不该报成「超时」，否则排查时会去查网络而漏掉真正的取消来源。
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `${method} 请求超过 ${formatTimeout(effectiveTimeoutMs(deps))}未完成；请检查网络或代理设置`
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return `${method} 请求在完成前被中止`
  }
  return `请求 ${method} 失败：${describeError(error)}`
}

/** 解析登录态文件：兼容嵌套 `token.{...}` 与平铺两种历史形态。 */
export function parseTokenState(raw: unknown): QuotaTokenState {
  const root = isRecord(raw) ? raw : {}
  const token = isRecord(root.token) ? root.token : root
  const pick = (key: string): string | undefined => {
    const value = token[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const outer = (key: string): string | undefined => {
    const value = root[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  // 平铺形态下 token === root，`pick` 已经覆盖外层；再去查一次是纯重复。
  // 三个字段统一走这条路径，否则只有 accessToken 被优化、另两个仍会重复查询。
  const readOuter = (key: string): string | undefined => (token === root ? undefined : outer(key))
  const first = (nested: string, flat: string): string | undefined => pick(nested) ?? readOuter(flat)
  return {
    accessToken: pick('access_token') ?? pick('AccessToken') ?? readOuter('access_token') ?? readOuter('AccessToken'),
    refreshToken: first('refresh_token', 'refresh_token'),
    expiry: first('expiry', 'expiry'),
  }
}

/** 是否还可直接使用（缺 expiry 视为不过期，由调用方按请求失败再兜底）。 */
export function isTokenUsable(state: QuotaTokenState, nowMs: number, marginMs = TOKEN_EXPIRY_MARGIN_MS): boolean {
  if (!state.accessToken) return false
  if (!state.expiry) return true
  const expiresAt = Date.parse(state.expiry)
  if (Number.isNaN(expiresAt)) return true
  return expiresAt - nowMs > marginMs
}

/** 官方二进制里 client 元数据的匹配器（只读，不用 lastIndex）。 */
const CLIENT_ID_PATTERN = /\d+-[a-z0-9]+\.apps\.googleusercontent\.com/g
const CLIENT_SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]{28}/g

/** 一个 client 元数据片段及其在分发物里的绝对位置（配对靠位置）。 */
interface ClientCandidate {
  value: string
  at: number
}

/** 收集匹配片段；块间重叠会让同一片段被重复匹配，按绝对位置去重。 */
function collectClientCandidates(
  text: string,
  base: number,
  sinks: { ids: ClientCandidate[]; secrets: ClientCandidate[] },
): void {
  for (const match of text.matchAll(CLIENT_ID_PATTERN)) {
    const index = match.index ?? 0
    // 块边界可能把一个 client id 从数字串中间切断：剩余部分（如 `90-abc…`）本身
    // 又是合法的 id 形态，会以「幻影 id」进入候选，且位置去重去不掉它。
    // 这种截断尾巴只可能出现在本块起点（index 0，base>0）；真正的起点在上一个
    // 块里、早已按正确绝对位置收集过（token 长度 << 256 字符重叠窗），因此丢弃安全。
    if (index === 0 && base > 0) continue
    const at = base + index
    if (!sinks.ids.some((entry) => entry.at === at)) sinks.ids.push({ value: match[0], at })
  }
  for (const match of text.matchAll(CLIENT_SECRET_PATTERN)) {
    const at = base + (match.index ?? 0)
    if (!sinks.secrets.some((entry) => entry.at === at)) sinks.secrets.push({ value: match[0], at })
  }
}

/**
 * 按位置配对 client id 与 secret；取不到返回 undefined（绝不拼凑）。
 *
 * 官方分发物里可能同时打包多组 client（实测 agy 1.5.9 Linux 有三组：Gemini CLI、
 * antigravity 及其它内部客户端）。位置配对在真实二进制上不稳定：选中的那一对
 * 会让 OAuth 端点回 `invalid_client` / `unauthorized_client`，表现为「换发 401」。
 * 已审计实现里那份 Antigravity client 才是本链路真正在用的，两半都在就优先它；
 * 不在时取「最后一个 id 之后位置最近的 secret」，绝不编造。
 */
function pickOAuthClient(ids: ClientCandidate[], secrets: ClientCandidate[]): OAuthClientMeta | undefined {
  if (ids.length === 0 || secrets.length === 0) return undefined
  if (ids.some((entry) => entry.value === ANTIGRAVITY_CLIENT_ID)
    && secrets.some((entry) => entry.value === ANTIGRAVITY_CLIENT_SECRET)) {
    return { clientId: ANTIGRAVITY_CLIENT_ID, clientSecret: ANTIGRAVITY_CLIENT_SECRET }
  }
  // 与官方 CLI 同源的最后一条 client id 最可能是当前在用的。
  const last = ids[ids.length - 1] as ClientCandidate
  // 同一份元数据里 secret 紧跟 id；多份时取该 id 之后位置最近的 secret。
  const after = secrets.filter((entry) => entry.at > last.at).sort((a, b) => a.at - b.at)[0]
  if (after !== undefined) return { clientId: last.value, clientSecret: after.value }
  // 之后没有 secret：按旧规则回退到「首次出现位置最后」的那份（极少数只写 secret
  // 的打包形态）；保持与整文本解析一致的语义。
  const firstAt = new Map<string, number>()
  for (const entry of secrets) if (!firstAt.has(entry.value)) firstAt.set(entry.value, entry.at)
  let chosen: ClientCandidate | undefined
  for (const [value, at] of firstAt) {
    if (chosen === undefined || at > chosen.at) chosen = { value, at }
  }
  return chosen === undefined ? undefined : { clientId: last.value, clientSecret: chosen.value }
}

/** 从官方二进制文本里提取 client 元数据；取不到返回 undefined（不猜值）。 */
export function parseOAuthClientFromBinary(text: string): OAuthClientMeta | undefined {
  const sinks = { ids: [] as ClientCandidate[], secrets: [] as ClientCandidate[] }
  collectClientCandidates(text, 0, sinks)
  return pickOAuthClient(sinks.ids, sinks.secrets)
}

/**
 * 从**分块**文本流里提取 client 元数据。
 *
 * 分块是硬要求：V8 单字符串上限约 512MB（`buffer.constants.MAX_STRING_LENGTH`
 * = 536,870,888），而 1.5.x 的 Linux `agy_acp_server.par` 已到 714MB；旧实现整文件
 * `readFile(path, 'latin1')` 会抛 `Invalid string length`，被 catch 掉后静默返回
 * undefined，表现为 access token 每小时过期时额度读取都报「拿不到 OAuth client
 * 元数据」。这里按块解码、保留尾部重叠再匹配，内存只占一块。
 */
export async function parseOAuthClientFromChunks(
  chunks: AsyncIterable<string>,
): Promise<OAuthClientMeta | undefined> {
  const sinks = { ids: [] as ClientCandidate[], secrets: [] as ClientCandidate[] }
  let carry = ''
  let consumed = 0
  for await (const chunk of chunks) {
    const text = carry + chunk
    // 绝对位置 = 已消费字符数 - 重叠段长度（carry 是上块尾部重复的内容）。
    collectClientCandidates(text, consumed - carry.length, sinks)
    carry = text.slice(-BINARY_SCAN_OVERLAP_CHARS)
    consumed += chunk.length
  }
  return pickOAuthClient(sinks.ids, sinks.secrets)
}

/**
 * 按块读取官方二进制并解码成文本流：latin1 逐字节映射，目标串全是 ASCII。
 * 用 utf8 解码 200MB 级二进制要 ~700ms（实测），latin1 只要 ~60ms。
 */
async function* readBinaryChunks(path: string): AsyncGenerator<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(BINARY_SCAN_CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, BINARY_SCAN_CHUNK_BYTES, null)
      // 只有 EOF 才结束：定期文件读通常一次读完，但短读（信号/NFS）不能被当 EOF，
      // 否则会静默漏掉后半截分发物。
      if (bytesRead === 0) return
      yield buffer.subarray(0, bytesRead).toString('latin1')
    }
  } finally {
    await handle.close()
  }
}

/**
 * 解析 OAuth client 元数据，来源优先级：
 * 1. `AGY_OAUTH_CLIENT_ID` / `AGY_OAUTH_CLIENT_SECRET` 环境变量；
 * 2. 本机官方分发物（agy CLI / 已解压的 ACP server，**分块**扫描）；
 * 3. `@cortexkit/antigravity-auth-core` 里已审计的 Antigravity client——设置页的
 *    OAuth 登录本就用这一对，登录出来的 refresh_token 与它配套。
 *
 * 三者都是真实存在的 client，不编造；返回值带 `source`，换发 401 时据此给提示。
 */
export async function resolveOAuthClient(deps: QuotaDeps = {}): Promise<OAuthClientMeta> {
  const env = deps.env ?? process.env
  const clientId = env.AGY_OAUTH_CLIENT_ID?.trim()
  const clientSecret = env.AGY_OAUTH_CLIENT_SECRET?.trim()
  if (clientId && clientSecret) return { clientId, clientSecret, source: 'env' }
  const streamOf = deps.binaryChunkStreamImpl ?? readBinaryChunks
  for (const candidate of await candidateBinaryPaths(deps)) {
    try {
      const meta = await parseOAuthClientFromChunks(streamOf(candidate))
      if (meta) return { ...meta, source: 'binary' }
    } catch {
      // 读不到就试下一个候选；提取失败不是致命错误。
    }
  }
  return { clientId: ANTIGRAVITY_CLIENT_ID, clientSecret: ANTIGRAVITY_CLIENT_SECRET, source: 'audited' }
}

/** 官方二进制候选：缓存里的 agy_acp_server + 本机官方 agy CLI。
 *
 * 实测（2026-10-16，本机）：OAuth client 元数据只随 **agy CLI** 发行，
 * `agy_acp_server.exe` 里没有；因此两个来源都要扫。
 */
async function candidateBinaryPaths(deps: QuotaDeps): Promise<string[]> {
  if (deps.binaryPaths) return [...deps.binaryPaths]
  const home = (deps.homedir ?? homedir)()
  const env = deps.env ?? process.env
  // 安装根是**用户级**的：隔离账号只覆盖 HOME（登录态按 HOME 读），缓存里的官方
  // 二进制仍在真实用户目录下。用账号 HOME 推这里会指向
  // `<账号 HOME>/.cache/dsh-antigravity-host/...`（不存在），扫描必然落空。
  const installRoot = deps.installRoot ?? resolveInstallRoot(env, process.platform, deps.systemHomedir ?? homedir)
  const { extractDir } = versionCachePaths(installRoot, deps.acpVersion ?? DEFAULT_ACP_SERVER_VERSION)
  const names = process.platform === 'win32'
    ? ['agy.exe', 'agy_acp_server.exe', 'agy-acp-server.exe']
    : ['agy', 'agy_acp_server.par', 'agy_acp_server', 'agy-acp-server']
  // 官方 agy CLI 才携带 client 元数据，排最前；缓存里的 ACP server 只是兜底
  // （每次白扫它要多读 80MB+）。
  const out = [...agyCliCandidates(env, home, deps.cliPath)]
  if (env.AGY_ACP_BIN?.trim()) out.push(env.AGY_ACP_BIN.trim())
  const scan = async (directory: string, depth: number): Promise<void> => {
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && names.includes(entry.name)) out.push(join(directory, entry.name))
        else if (entry.isDirectory() && depth < 2) await scan(join(directory, entry.name), depth + 1)
      }
    } catch {
      // 缓存目录不存在：跳过。
    }
  }
  await scan(extractDir, 0)
  return [...new Set(out)]
}

/** 用 refresh_token 换发 access_token（只在内存中使用，不写回登录文件）。 */
export async function refreshAccessToken(
  state: QuotaTokenState,
  client: OAuthClientMeta,
  deps: QuotaDeps = {},
): Promise<QuotaTokenState> {
  if (!state.refreshToken) {
    throw new QuotaError('token-expired', '登录态里没有 refresh_token，无法换发')
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const tokenUrl = deps.tokenUrl ?? OAUTH_TOKEN_URL
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: state.refreshToken,
  })
  let response: Response
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: timeoutSignal(deps),
    })
  } catch (error) {
    // 不把 tokenUrl 带进消息：URL 本身不带凭据，但错误文本只保留可行动信息。
    throw new QuotaError('refresh-failed', describeRequestError('换发 access token', error, deps))
  }
  if (!response.ok) {
    throw new QuotaError('refresh-failed', `换发 access token 失败（HTTP ${response.status}）`, response.status)
  }
  const payload = await readJson(response)
  const issued = isRecord(payload) ? payload : {}
  const accessToken = typeof issued.access_token === 'string' ? issued.access_token : undefined
  if (!accessToken) {
    throw new QuotaError('refresh-failed', '换发响应里没有 access_token')
  }
  const expiresIn = typeof issued.expires_in === 'number' ? issued.expires_in : 3600
  return {
    accessToken,
    refreshToken: typeof issued.refresh_token === 'string' ? issued.refresh_token : state.refreshToken,
    expiry: new Date((deps.now ?? Date.now)() + expiresIn * 1000).toISOString(),
  }
}

/** 带错误码的取数失败；message 里不含凭据。 */
export class QuotaError extends Error {
  readonly code: QuotaErrorCode
  /**
   * 上游 HTTP 状态码（换发 token 与 Cloud Code Assist 请求）。
   *
   * 401/403 后的「换发再试一次」必须按这个字段判断，不能去匹配 message：
   * 文案随时会改，改一次就静默丢掉重试。非 HTTP 失败（网络、JSON、缺字段）
   * 为 undefined。
   */
  readonly status: number | undefined

  constructor(code: QuotaErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'QuotaError'
    this.code = code
    this.status = status
  }
}

/** `loadCodeAssist` 响应里我们只认项目 id 与档位名。 */
export interface CodeAssistProject {
  projectId: string
  plan?: string
}

/** 拉取 Code Assist 项目与订阅档位。 */
export async function loadCodeAssist(accessToken: string, deps: QuotaDeps = {}): Promise<CodeAssistProject> {
  const payload = await postCodeAssist('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, accessToken, deps)
  const projectId = typeof payload.cloudaicompanionProject === 'string' ? payload.cloudaicompanionProject : ''
  if (!projectId) {
    throw new QuotaError('bad-response', 'loadCodeAssist 未返回 cloudaicompanionProject')
  }
  const tiers = [payload.paidTier, payload.currentTier]
  const plan = tiers
    .map((tier) => (isRecord(tier) && typeof tier.name === 'string' ? tier.name : undefined))
    .find((name) => name)
  return { projectId, ...(plan === undefined ? {} : { plan }) }
}

/** 解析额度汇总响应（groups/buckets）。 */
export function parseQuotaSummary(raw: unknown): QuotaGroup[] {
  const root = isRecord(raw) ? raw : {}
  const rawGroups = Array.isArray(root.groups) ? root.groups : []
  return rawGroups.filter(isRecord).map((group) => {
    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : []
    return {
      name: firstString(group.displayName) ?? '额度',
      ...(firstString(group.description) === undefined ? {} : { description: firstString(group.description) }),
      buckets: rawBuckets.filter(isRecord).map((bucket) => {
        const fraction = normalizeFraction(bucket.remainingFraction)
        return {
          name: firstString(bucket.displayName) ?? firstString(bucket.bucketId) ?? '额度',
          ...(firstString(bucket.description) === undefined ? {} : { description: firstString(bucket.description) }),
          ...(firstString(bucket.window) === undefined ? {} : { window: firstString(bucket.window) }),
          ...(fraction === undefined ? {} : { remainingFraction: fraction, remainingPct: Math.round(fraction * 10000) / 100 }),
          ...(firstString(bucket.resetTime) === undefined ? {} : { resetTime: firstString(bucket.resetTime) }),
          disabled: bucket.disabled === true,
        }
      }),
    }
  })
}

/** 取一份额度快照（内存缓存 + 过期 token 换发 + 401/403 重试一次）。 */
export async function fetchQuotaSnapshot(
  cache: { value?: QuotaSnapshot; at?: number },
  deps: QuotaDeps = {},
): Promise<QuotaSnapshot> {
  const now = deps.now ?? Date.now
  const cached = cache.value
  if (cached && cache.at !== undefined && now() - cache.at < QUOTA_CACHE_MS && cached.status === 'ok') {
    return cached
  }
  const snapshot = await fetchQuotaSnapshotUncached(deps)
  cache.value = snapshot
  cache.at = now()
  return snapshot
}

async function fetchQuotaSnapshotUncached(deps: QuotaDeps): Promise<QuotaSnapshot> {
  const now = deps.now ?? Date.now
  const stamp = () => new Date(now()).toISOString()
  try {
    const readFileImpl = deps.readFileImpl ?? defaultReadFile
    const home = (deps.homedir ?? homedir)()
    const tokenPath = join(home, ...TOKEN_SUBPATH)
    let state: QuotaTokenState
    try {
      state = parseTokenState(JSON.parse(await readFileImpl(tokenPath)))
    } catch {
      return failure(stamp(), 'token-missing', '读不到官方 CLI 登录态（antigravity-oauth-token）')
    }
    if (!state.accessToken && !state.refreshToken) {
      return failure(stamp(), 'token-missing', '官方 CLI 登录态里没有可用 token，请先在 Antigravity 登录')
    }
    if (!isTokenUsable(state, now())) {
      const client = await resolveOAuthClient(deps)
      try {
        state = await refreshAccessToken(state, client, deps)
      } catch (error) {
        return failure(stamp(), 'refresh-failed', describeRefreshFailure(error, client))
      }
    }
    const accessToken = state.accessToken as string
    try {
      const project = await loadCodeAssist(accessToken, deps)
      const summary = await postCodeAssist('retrieveUserQuotaSummary', { project: project.projectId }, accessToken, deps)
      return {
        status: 'ok',
        updatedAt: stamp(),
        ...(project.plan === undefined ? {} : { plan: project.plan }),
        groups: parseQuotaSummary(summary),
      }
    } catch (error) {
      // 401/403：token 被上游拒绝（可能刚换发也失效），换发一次再试。
      if (error instanceof QuotaError && error.code === 'request-failed'
        && (error.status === 401 || error.status === 403)) {
        return retryAfterRefresh(state, stamp, deps)
      }
      return failure(stamp(), errorCodeOf(error), describeError(error))
    }
  } catch (error) {
    return failure(stamp(), errorCodeOf(error), describeError(error))
  }
}

async function retryAfterRefresh(
  state: QuotaTokenState,
  stamp: () => string,
  deps: QuotaDeps,
): Promise<QuotaSnapshot> {
  try {
    const client = await resolveOAuthClient(deps)
    let refreshed: QuotaTokenState
    try {
      refreshed = await refreshAccessToken(state, client, deps)
    } catch (error) {
      return failure(stamp(), 'refresh-failed', describeRefreshFailure(error, client))
    }
    const project = await loadCodeAssist(refreshed.accessToken as string, deps)
    const summary = await postCodeAssist(
      'retrieveUserQuotaSummary',
      { project: project.projectId },
      refreshed.accessToken as string,
      deps,
    )
    return {
      status: 'ok',
      updatedAt: stamp(),
      ...(project.plan === undefined ? {} : { plan: project.plan }),
      groups: parseQuotaSummary(summary),
    }
  } catch (error) {
    return failure(stamp(), errorCodeOf(error), describeError(error))
  }
}

async function postCodeAssist(
  method: string,
  payload: Record<string, unknown>,
  accessToken: string,
  deps: QuotaDeps,
): Promise<Record<string, unknown>> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const base = (deps.baseUrl ?? CODE_ASSIST_BASE_URL).replace(/\/+$/, '')
  // Cloud Code Assist 按调用方的线身份判定客户端：只发 `metadata.ideType` 时上游回
  // HTTP 200 但没有 `cloudaicompanionProject`，并在 ineligibleTiers 里给出
  // `UNSUPPORTED_CLIENT`（实测 2026-11-17）。补上 agy 线头（User-Agent +
  // Accept-Encoding）后同一账户正常返回项目与套餐。
  const headers: Record<string, string> = {
    ...buildAntigravityHarnessBootstrapHeaders(accessToken),
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  let response: Response
  try {
    response = await fetchImpl(`${base}:${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: timeoutSignal(deps),
    })
  } catch (error) {
    throw new QuotaError('request-failed', describeRequestError(method, error, deps))
  }
  if (!response.ok) {
    throw new QuotaError('request-failed', `${method} 失败（HTTP ${response.status}）`, response.status)
  }
  const body = await readJson(response)
  return isRecord(body) ? body : {}
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new QuotaError('bad-response', '响应不是合法 JSON')
  }
}

function failure(updatedAt: string, code: QuotaErrorCode, message: string): QuotaSnapshot {
  return { status: 'error', updatedAt, groups: [], error: { code, message: redactSensitiveText(message) } }
}

function errorCodeOf(error: unknown): QuotaErrorCode {
  return error instanceof QuotaError ? error.code : 'request-failed'
}

function describeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
}

/**
 * 换发失败文案：回落到已审计 client 时若被 OAuth 端点拒（401/403），说明该 client
 * 与 refresh_token 的签发方不一致（系统账号的 token 由官方 CLI 签发），要给出可
 * 行动提示，而不是让用户对着「拿不到 client 元数据」猜。
 */
function describeRefreshFailure(error: unknown, client: OAuthClientMeta): string {
  const message = describeError(error)
  // 按「实际用的 client 是不是已审计那一对」判断，而不是只看来路：分发物里命中的
  // 往往正是已审计那一对（source 会是 binary）。Google 对 invalid_client /
  // invalid_grant 都可能回 400，所以 400/401/403 一并给提示。
  const audited = client.clientId === ANTIGRAVITY_CLIENT_ID && client.clientSecret === ANTIGRAVITY_CLIENT_SECRET
  if (audited && error instanceof QuotaError && (error.status === 400 || error.status === 401 || error.status === 403)) {
    return `${message}；可能是已审计 client 与本机登录态的签发方不一致，或登录态已失效：系统账号请先用官方 agy CLI 登录，或在 Host 环境设置 AGY_OAUTH_CLIENT_ID/SECRET`
  }
  return message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeFraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0 || value > 1) return undefined
  return value
}
