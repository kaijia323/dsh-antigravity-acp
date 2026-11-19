/**
 * Cordis 插件入口：向 ctx.llm 注册 antigravity-acp provider 的 LlmAdapter。
 *
 * 注入 'llm'（adapter 注册表）与 'subprocess'（生命周期受管子进程服务）。
 * 子进程一律经 ctx.subprocess 创建，绝不 import child_process。
 *
 * 生命周期闭环：dispose 时终止受管进程并关闭 AgentLink，确认退出后释放运行目录，
 * 最后关闭插件进程内的私有 loopback MCP 桥。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type { ClientCapabilities } from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AntigravityAcpAdapter, AGY_PROVIDER_ID } from './adapter/antigravity-adapter.js'
import { mergeModelRows } from './adapter/model-rows.js'
import type { AdapterMetadata } from './adapter/antigravity-adapter.js'
import { ConversationWorkers } from './pool/conversation-workers.js'
import { AgentLink, agentStreamFromSubprocess, AGY_CLIENT_INFO, AGY_LINK_ERROR, launchAcpAgent } from './protocol/agent-link.js'
import type { AgentLinkHandlers } from './protocol/agent-link.js'
import {
  AGY_BINARY_ERROR,
  DEFAULT_ACP_SERVER_VERSION,
  ensureAgentBinary,
  resolveCacheDir,
  resolveInstallRoot,
  createRuntimeDirectory,
  releaseRuntimeDirectory,
  defaultAgentArgs,
} from './runtime/binary.js'
import type { RuntimeDirectory } from './runtime/binary.js'
import { ProxyConfigError, resolveProxy } from './runtime/proxy-env.js'
import { createLiveProxiedFetch, createProxiedFetch } from './runtime/proxied-fetch.js'
import type { ResolvedProxy } from './runtime/proxy-env.js'
import { ensureAcpCredentials, writeAcpCredentialFiles } from './runtime/credentials.js'
import type { AcpCredentialResult } from './runtime/credentials.js'
import { describeLowIntegrity, isLowIntegrityTarget } from './runtime/integrity.js'
import { describeAuthWait, redactSensitiveText } from './runtime/redact.js'
import { readCachedCatalog, writeCachedCatalog } from './runtime/catalog-cache.js'
import { createFileSessionMapStore } from './runtime/session-map.js'
import { agyCliCandidates, createSubprocessCliRun, fetchAgyModels } from './runtime/agy-cli.js'
import { AgYQuotaService, registerAgYQuotaRemote } from './quota/quota-remote.js'
import { SettingsControl } from './quota/control.js'
import { AcpLifecycle } from './runtime/lifecycle.js'
import { AccountsManager } from './accounts/manager.js'
import { resolveAccountsDir } from './accounts/paths.js'
import { resolveOAuthClient } from './runtime/quota.js'
import { liveHostConfig } from './settings.js'
import type { AntigravityHostConfig, AntigravityPluginConfig } from './settings.js'

export { AGY_PROVIDER_ID } from './adapter/antigravity-adapter.js'
export { Config } from './settings.js'
export type { AntigravityHostConfig } from './settings.js'

// Loader is optional in headless compositions; its live-update event is scoped
// to the owning plugin fiber, so unrelated settings never invalidate our catalog.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: string[][]): void
  }
}

export const name = 'llm-antigravity-acp'
export const inject = ['llm', 'subprocess']

/**
 * 本插件向 agent 声明的 client 能力：**全部关闭**。
 *
 * 无人值守原则：工具一律经私有 loopback MCP 桥暴露给 agent，agent 不直接
 * 触碰宿主文件系统或终端。因此 fs 读写与 terminal 全部为 false，agent 若仍
 * 发起这些原生请求，会被 adapter 记为「非预期原生活动」并终止回合
 * （见 adapter/prompt-turn.ts）。elicitation 也一并关闭：无人应答可收集。
 */
export const AGY_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  // elicitation 整体省略：按 ACP d.ts，省略与 null 等价于不声明该能力，
  // 因此 agent 不会发起 session/create_elicitation。
}

/** 本插件持有并需在 dispose 时清理的活动 ACP 资源。 */
export interface ActiveAcpRuntime {
  directory?: RuntimeDirectory
  lifecycle?: AcpLifecycle
  link?: AgentLink
  handle?: SubprocessHandle
  /**
   * 正在进行的启动流程。`ensureAcpRuntime` 的判重到写入 `link` 之间横跨
   * `ensureAgentBinary` / `mkdir` / spawn 多个 await，仅靠同步的 `active.link`
   * 检查无法阻止并发首轮各自 spawn 一条官方进程（进而孤儿一条 handle、双弹一次
   * OAuth）。这个 promise 让并发调用汇聚到同一次启动。
   */
  inflight?: Promise<AgentLink>
  /** 建立当前链路时使用的账号 id；切换账号后下一次启动据此回收旧连接。 */
  accountId?: string
  /** 建立当前链路时的登录态代际。 */
  accountRevision?: number
  /** 插件已卸载。置位后不再启动新链路，dispose 会等在途启动收尾再清理。 */
  disposed?: boolean
  /** 卸载时中止在途的二进制下载（否则卸载要等一次可能长达数分钟的下载）。 */
  abort?: AbortController
  /** 插件进程内私有 loopback MCP 桥的关闭钩子（由 adapter 登记）。 */
  bridgeTeardown?: () => Promise<void>
}

/**
 * 清理顺序（apply 的 dispose 与测试共用同一条路径）：
 *
 * 1. 置 `disposed`，让此后进来的 `ensureAcpRuntime` 立刻失败而不是再 spawn；
 * 2. **先切断链路**：`link?.close()` + `handle?.terminate()`。必须在等 in-flight
 *    之前做——否则一个正卡在 `authenticate`（最长 `authTimeoutMs`，默认 5 分钟）
 *    的启动会把卸载拖到用户点完登录为止，而调用方还会拿到一条刚认证成功、
 *    随即被关掉的链接（假成功）；
 * 3. 等在途启动收尾。它此时会因链路断开而失败，错误被吞掉；仍兜住一种极端情况：
 *    in-flight 已经越过 spawn、还没来得及 terminate 自己的 handle。
 * 4. 关闭私有 MCP 桥。
 */
export async function disposeAcpRuntime(active: ActiveAcpRuntime): Promise<void> {
  active.disposed = true
  // 同步封住 adapter 的生产者与定时器，再切断链接；不等待桥清理才终止子进程。
  const bridgeCleanup = active.bridgeTeardown?.()
  void bridgeCleanup?.catch(() => undefined)
  active.abort?.abort(new Error('插件已卸载'))
  active.handle?.terminate()
  await active.link?.close().catch(() => undefined)
  await active.inflight?.catch(() => undefined)
  const handle = active.handle
  handle?.terminate()
  if (active.directory && (!handle || await handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false))) {
    await releaseRuntimeDirectory(active.directory).catch(() => undefined)
    active.directory = undefined
  }
  await bridgeCleanup
  active.lifecycle?.stopped('disposed')
}

export type { AgentLinkHandlers }

/** 回收失败/取消的连接与其受管进程，不卸载插件；旧连接不能终止后来者。 */
export async function recycleAcpRuntime(active: ActiveAcpRuntime, link: AgentLink): Promise<void> {
  const handle = active.link === link ? active.handle : undefined
  if (active.link === link) active.lifecycle?.recycling()
  handle?.terminate()
  await link.close()
  if (handle && !await handle.waitForExit(AbortSignal.timeout(10_000))) {
    throw new LlmError('Antigravity ACP 受管进程未能在回收期限内退出，拒绝开启新回合', AGY_LINK_ERROR.LINK_CLOSED)
  }
  if (active.link === link && active.directory) {
    await releaseRuntimeDirectory(active.directory).catch(() => undefined)
    active.directory = undefined
  }
  if (active.link === link) { active.link = undefined; active.lifecycle?.stopped() }
  if (handle && active.handle === handle) active.handle = undefined
}

/**
 * 启动路径上的可注入外部依赖。
 *
 * 两者都是「会碰真实环境」的动作（读/写用户 profile、跑系统命令），生产用默认
 * 实现，测试用假实现——否则单元测试会去动真实登录态、并让假 subprocess 收到一条
 * 它不认识的 icacls 进程。
 */
export interface AcpRuntimeDeps {
  /** 预热只使用已有登录态，不触发浏览器登录。 */
  allowInteractiveAuth?: boolean
  /** 当前账号 id：与已建立链路不同时先回收旧连接，再按新账号启动。 */
  accountId?: string
  /** 当前账号的隔离 HOME；系统账号省略。 */
  accountHome?: string
  /** 登录态代际：重新登录同一账号后递增，迫使已建立链路重建。 */
  accountRevision?: number
  /** 当前启动请求的取消信号，不改变宿主权限。 */
  signal?: AbortSignal
  /** 插件自身 HTTPS 请求（下载、换发）所用的 fetch；默认按配置的代理构造。 */
  fetchImpl?: typeof fetch
  /** 备好官方登录态（acp_token.json + settings.json）；默认导入本机官方 CLI 凭据。 */
  ensureCredentials?: () => Promise<AcpCredentialResult>
  /** Windows 低完整性探测；默认经 ctx.subprocess 只读跑一次 icacls。 */
  probeLowIntegrity?: (executablePath: string, subprocess: SubprocessRuntime) => Promise<boolean>
}

/**
 * 创建并启动 ACP 运行时（解析二进制 → ctx.subprocess spawn → initialize →
 * authenticate）。
 *
 * **single-flight**：并发调用共享同一个启动 promise，只 spawn 一条官方进程、
 * 只 authenticate 一次。
 *
 * 三条判定的顺序是有讲究的，**不可交换**：
 * 1. `disposed` 优先——插件卸载后不接受任何启动；
 * 2. `inflight` 必须在 `link` 之前：`authenticate` 可能要等人工在浏览器完成授权
 *    （默认 5 分钟），期间到达的调用必须汇聚到同一次启动，而**不能**拿到一条尚未
 *    认证的链接去 `session/new`；
 * 3. `link` 只在 initialize + authenticate **都成功后**才被写入（见
 *    `startAcpRuntime`），因此它可复用即代表链路已认证。
 *
 * 失败不留残骸：initialize / authenticate 任一失败（异常或超时）都会关闭旧
 * link、终止旧 handle、清掉 inflight 后再抛出原错误，保证下次调用能全新重试，
 * 而不是复用一条死链或缓存一个 rejected promise。
 */
export async function ensureAcpRuntime(
  ctx: Context,
  config: AntigravityHostConfig,
  handlers: AgentLinkHandlers,
  active: ActiveAcpRuntime,
  deps: AcpRuntimeDeps = {},
): Promise<AgentLink> {
  if (active.disposed) {
    throw new LlmError('Antigravity ACP 插件已卸载，无法启动 ACP 链路', AGY_LINK_ERROR.LINK_CLOSED)
  }
  if (active.inflight) return active.inflight
  // 账号切换：已建立的链路属于旧账号，先在同一 single-flight 里回收再重新启动。
  if (active.link && deps.accountId !== undefined
    && (active.accountId !== deps.accountId
      || (deps.accountRevision !== undefined && active.accountRevision !== deps.accountRevision))) {
    await recycleAcpRuntime(active, active.link)
  }
  if (active.link) {
    if (!active.link.closed) { active.lifecycle?.reused(); return active.link }
    // 链路自己关了（对端断流 / 流读取失败 / 回收中途失败）但子进程可能仍活着、
    // handle.done 不会触发：不能把这条死链永久交给调用方，否则之后每个回合都会
    // 在 session/new 上报「ACP 链路已关闭」直到重启。终止旧进程并全新启动。
  }
  // 同步赋值：startAcpRuntime 内部第一个 await 之前不会有别的调用者插进来。
  active.lifecycle?.starting()
  const inflight = startAcpRuntime(ctx, config, handlers, active, deps)
  active.inflight = inflight
  try {
    return await inflight
  } catch (error) {
    if (!active.disposed) {
      active.lifecycle?.stopped()
      if (!deps.signal?.aborted) active.lifecycle?.failed(error)
    }
    throw error
  } finally {
    // 成功路径下 link 已就位；失败路径下这里清掉 inflight，让下次能全新重试。
    // 只有仍是本次这一个 promise 时才清，避免误删后来者的。
    if (active.inflight === inflight) active.inflight = undefined
  }
}

/** 真正执行一次启动的内部实现；调用方负责 single-flight 汇聚。 */
async function startAcpRuntime(
  ctx: Context,
  config: AntigravityHostConfig,
  handlers: AgentLinkHandlers,
  active: ActiveAcpRuntime,
  deps: AcpRuntimeDeps,
): Promise<AgentLink> {
  // Recovery belongs to the same single-flight operation as creation.
  if (active.link) await recycleAcpRuntime(active, active.link)
  if (active.handle) {
    active.handle.terminate()
    if (!await active.handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)) {
      throw new LlmError('前一个 ACP 进程尚未确认退出，无法安全启动新连接', AGY_LINK_ERROR.LINK_CLOSED)
    }
    active.handle = undefined
    if (active.directory) {
      await releaseRuntimeDirectory(active.directory).catch(() => undefined)
      active.directory = undefined
    }
  }
  const subprocess: SubprocessRuntime = ctx.subprocess
  active.abort ??= new AbortController()
  // 非法代理在启动这一层转成带 AGY_ 前缀的 LlmError：既给出可行动文案，也不会
  // 命中宿主的默认可重试词表（整步重放会重复 spawn 与 OAuth）。
  const downloadProxy = (() => {
    try {
      return resolveProxy({ url: config.proxyUrl?.trim(), bypass: config.proxyBypass })
    } catch (error) {
      if (!(error instanceof ProxyConfigError)) throw error
      throw new LlmError(`代理配置无效，无法启动 ACP：${error.message}`, 'AGY_INVALID_PROXY')
    }
  })()
  const startupSignal = AbortSignal.any([active.abort.signal, ...(deps.signal ? [deps.signal] : [])])
  startupSignal.throwIfAborted()
  const ownedFetch = deps.fetchImpl ? undefined : createProxiedFetch(downloadProxy)
  const baseFetch = deps.fetchImpl ?? ownedFetch!
  const pluginFetch: typeof fetch = (input, init) => baseFetch(input, {
    ...init,
    signal: AbortSignal.any([startupSignal, ...(init?.signal ? [init.signal] : [])]),
  })
  try {
    const resolution = await ensureAgentBinary({
      binaryPath: config.binaryPath,
      version: config.acpVersion,
      signal: startupSignal,
    })
    // Windows：映像文件若带 Low 强制完整性标签（例如装在带该标签的 DSH home 下），
    // 官方进程会被降成 LOW，受 MIC「禁止向上写」约束而写不进 ~/.gemini/antigravity-acp，
    // 表现为 session/new 永久挂起。这里只读探测一次并显式报错，不把挂死留给用户。
    const probeLowIntegrity =
      deps.probeLowIntegrity ?? ((path: string, sp: SubprocessRuntime) => isLowIntegrityTarget(path, (target) => runIcacls(sp, target)))
    if (await probeLowIntegrity(resolution.executablePath, subprocess)) {
      throw new LlmError(describeLowIntegrity(resolution.executablePath), AGY_BINARY_ERROR.LOW_INTEGRITY)
    }
    // 下载可能耗时数分钟，期间插件可能被卸载：这时不再 spawn，避免出现一个
    // dispose 之后才出生、无人终止的进程。
    if (active.disposed) {
      throw new LlmError('Antigravity ACP 插件已卸载，取消启动 ACP 链路', AGY_LINK_ERROR.LINK_CLOSED)
    }
    startupSignal.throwIfAborted()
    // 登录态在 spawn 前备好：优先导入本机官方 CLI 的已登录凭据（用户要求不弹浏览器
    // 登录页）。备好 acp_token.json + settings.json 后，官方 server 启动时自行完成
    // 认证，因此可以跳过 authenticate —— 该请求在没有交互式浏览器时会一直挂着。
    // 传入 acpVersion：OAuth client 元数据要从对应版本的缓存二进制里提取。
    active.lifecycle?.startupPhase('credentials')
    const credentials = await (deps.ensureCredentials
      ?? (() => ensureAcpCredentials({
        acpVersion: config.acpVersion,
        cliPath: config.agyCliPath,
        fetchImpl: pluginFetch,
        ...(deps.accountHome ? { homedir: () => deps.accountHome as string } : {}),
      })))()
    startupSignal.throwIfAborted()
    if (!credentials.ready && deps.allowInteractiveAuth === false) {
      throw new LlmError('未找到可用的 ACP 登录态，请先使用“连接 / 登录 ACP”，然后再预热', 'AGY_AUTH_REQUIRED')
    }
    const proxy = downloadProxy
    active.lifecycle?.startupPhase('spawn')
    const directory = await createRuntimeDirectory()
    active.directory = directory
    let handle: SubprocessHandle
    try {
      startupSignal.throwIfAborted()
      if (await probeLowIntegrity(directory.path, subprocess)) {
        throw new LlmError(describeLowIntegrity(directory.path), AGY_BINARY_ERROR.LOW_INTEGRITY)
      }
      startupSignal.throwIfAborted()
      handle = launchAcpAgent(subprocess, {
        executable: resolution.executablePath,
        extraArgs: [...defaultAgentArgs(), ...(config.extraArgs ?? [])],
        tmpDir: directory.path,
        proxy,
        ...(deps.accountHome ? { homeDir: deps.accountHome } : {}),
      })
    } catch (error) {
      await releaseRuntimeDirectory(directory).catch(() => undefined)
      active.directory = undefined
      throw error
    }
    active.handle = handle
    active.lifecycle?.spawned()
    let link: AgentLink | undefined
    const cancelStartup = (): void => {
      handle.terminate()
      void link?.close().catch(() => undefined)
    }
    try {
      link = new AgentLink({
        stream: agentStreamFromSubprocess(handle),
        clientInfo: AGY_CLIENT_INFO,
        handlers,
        requestTimeoutMs: config.requestTimeoutMs,
        handshakeTimeoutMs: config.handshakeTimeoutMs ?? 120_000,
        // 认证需要人工在浏览器里点授权，走独立的更长超时（默认 5 分钟）。
        authTimeoutMs: config.authTimeoutMs,
      })
      startupSignal.addEventListener('abort', cancelStartup, { once: true })
      link.start()
      startupSignal.throwIfAborted()
      // initialize 上报关闭全部本地能力的 clientCapabilities（ACP v1 的
      // ClientCapabilities 属于 initialize 请求，session/new 没有这个字段）。
      active.lifecycle?.startupPhase('initialize')
      await link.initialize({ clientCapabilities: AGY_CLIENT_CAPABILITIES })
      // 登录态已就绪（acp_token.json + settings.json 齐备）时跳过 authenticate：
      // 官方 server 已从 settings.json 推断出 oauth-personal 并自行完成认证，
      // 而 authenticate 在没有交互式浏览器时会一直挂着（旧行为会白等 5 分钟）。
      if (!credentials.ready) {
        active.lifecycle?.startupPhase('authenticate')
        await link.authenticate()
      }
      startupSignal.throwIfAborted()
    } catch (error) {
      // active.link 尚未被写入（只有认证成功才写），这里只需摘掉 handle 指向。
      handle.terminate()
      await link?.close().catch(() => undefined)
      if (await handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)) {
        await releaseRuntimeDirectory(directory).catch(() => undefined)
        if (active.directory === directory) active.directory = undefined
        if (active.handle === handle) active.handle = undefined
      }
      throw toLaunchError(error, readStderr(handle), credentials.ready ? undefined : credentials.note)
    } finally {
      startupSignal.removeEventListener('abort', cancelStartup)
    }
    // 认证成功后才登记链接：`active.link` 可复用就等于「链路已认证」，因此复用它
    // 的调用方不需要、也不应该看到认证窗口内的中间状态。
    active.link = link
    active.accountId = deps.accountId
    active.accountRevision = deps.accountRevision
    const readyLink = link
    active.lifecycle?.ready()
    const startup = active.lifecycle?.read().startup
    if (startup) ctx.logger?.info?.(`antigravity-acp: ACP 连接就绪 startupMs=${Math.round(startup.elapsedMs)} timings=${JSON.stringify(startup.timings)}`)
    // 子进程意外退出：清掉 active 上的指向，否则下次 ensureAcpRuntime 会因
    // `if (active.link) return active.link` 永久复用死链（S2 的姊妹场景）。
    void handle.done
      .catch(() => undefined)
      .then(async () => {
        const exited = await handle.waitForExit(AbortSignal.timeout(10_000)).catch(() => false)
        if (exited) {
          await releaseRuntimeDirectory(directory).catch(() => undefined)
          if (active.directory === directory) active.directory = undefined
        }
        if (active.link === readyLink && exited) { active.link = undefined; active.lifecycle?.stopped() }
        if (active.handle === handle && exited) active.handle = undefined
        await readyLink.close().catch(() => undefined)
      })
    return link
  } finally {
    await ownedFetch?.close().catch(() => undefined)
  }
}

/**
 * 读取并脱敏官方进程的 stderr 尾部。官方会把完整 OAuth 授权 URL（含 state、
 * code_challenge）打进 stderr，未脱敏的原文不能进入错误消息。
 */
function readStderr(handle: SubprocessHandle): string {
  const raw = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
  return redactSensitiveText(raw).slice(-1500)
}

/**
 * 只读跑一次 `icacls <目标>` 读强制完整性标签。
 *
 * 经宿主的 subprocess 服务执行（本插件不 import child_process）；任何失败都返回
 * undefined，由调用方 fail-open——探测不可用不能让正常配置变得不可用。
 */
async function runIcacls(subprocess: SubprocessRuntime, target: string): Promise<string | undefined> {
  try {
    const handle = subprocess.spawn({
      argv: ['icacls', target],
      cwd: dirname(target),
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 * 1024 }, stderr: { maxBytes: 8 * 1024 } },
      graceMs: 3_000,
      signal: AbortSignal.timeout(10_000),
    })
    await handle.done.catch(() => undefined)
    return handle.collected.stdout?.readFrom(0).text
  } catch {
    return undefined
  }
}

/**
 * 把启动/握手失败包成 `LlmError`。
 *
 * 三处特例：
 * - 认证等待超时：官方会打印 `Launching browser login flow...`，此时用户需要的是
 *   「去浏览器完成授权」这条指引，而不是一串带凭据片段的 URL；
 * - 登录态准备失败（`note` 非空）：说明为什么插件没能免登录启动；
 * - 其余情况：附上脱敏后的 stderr 尾部作为诊断线索。
 */
function toLaunchError(error: unknown, stderr: string, credentialsNote?: string): LlmError {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'AGY_LINK_CLOSED'
  const message = error instanceof Error ? error.message : String(error)
  const waitingForLogin = describeAuthWait(stderr) !== undefined
  const detail = waitingForLogin ? describeAuthWait(stderr) : stderr || undefined
  const parts = [detail, credentialsNote].filter((part): part is string => Boolean(part))
  return new LlmError(
    parts.length > 0 ? `${message}（诊断：${parts.join('；')}）` : message,
    code,
    { cause: error },
  )
}

/** 设置页显式连接：独立运行时，只建空工具会话验证认证，不发送模型 prompt。 */
export async function connectAcpAccount(ctx: Context, config: AntigravityHostConfig, signal: AbortSignal, deps: AcpRuntimeDeps = {}) {
  const runtime: ActiveAcpRuntime = {}
  try {
    const link = await ensureAcpRuntime(ctx, config, {
      onRequestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    }, runtime, { ...deps, signal })
    return await link.newSession({ cwd: process.cwd(), mcpServers: [] }, { signal })
  } finally {
    await disposeAcpRuntime(runtime)
  }
}

/**
 * 面板登录时尽力打开默认浏览器；失败不阻断（授权链接始终交给客户端）。
 * 经 ctx.subprocess 启动，不 import child_process；只转发打开浏览器所需键。
 */
async function openDefaultBrowser(subprocess: SubprocessRuntime, url: string): Promise<boolean> {
  const platform = process.platform
  const argv = platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', 'start', '""', url]
    : platform === 'darwin' ? ['open', url] : ['xdg-open', url]
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SystemRoot']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  try {
    const handle = subprocess.spawn({
      argv,
      cwd: homedir(),
      env,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 2048 }, stderr: { maxBytes: 2048 } },
      graceMs: 1_000,
      signal: AbortSignal.timeout(5_000),
    })
    const outcome = await handle.done
    return outcome.exitCode === 0
  } catch {
    return false
  }
}

export function apply(ctx: Context, input: AntigravityPluginConfig): void {
  const config = liveHostConfig(input)
  const cacheDir = resolveCacheDir()
  const acpVersion = config.acpVersion ?? DEFAULT_ACP_SERVER_VERSION

  // 只回收带本插件所有权且已确认退出的运行目录；未知 / 活跃目录不按年龄删除。

  // 官方 agy CLI 的只读取数通道（额度 /usage 与模型清单 models）。2026-10-16
  // 用户授权「不 wrap agy CLI」**仅限只读取数用途**：只跑这两个只读命令，
  // 不发对话、不写文件。子进程一律经 ctx.subprocess。
  //
  // 代理规则与官方 ACP 进程一致：**配置的 proxyUrl 优先，其次宿主环境自身导出的
  // 代理**。CLI 每次启动都会做登录/配置刷新，缺代理会一直挂在网络上（实测），
  // 表现为额度药丸永远停在「额度…」。地址非法时以 AGY_INVALID_PROXY 明确失败。
  // 代理地址非法时不能让整个插件装载失败：设置卡片本身由本插件贡献，装载一失败，
  // 用户就没有任何界面修正这个值，只能去翻宿主配置文件。这里只告警、留痕，真正的
  // 非法地址在每次使用代理的操作里各自失败（连不上 / ProxyConfigError），并在设置页
  // 保持可编辑。已经带 userinfo 的地址不回显，只报可行动原因。
  const validateInitialProxy = (): void => {
    try {
      resolveProxy({ url: config.proxyUrl?.trim(), bypass: config.proxyBypass })
    } catch (error) {
      if (!(error instanceof ProxyConfigError)) throw error
      ctx.logger?.warn?.(
        `antigravity-acp: 代理配置无效，插件已加载但不会使用该代理（请到设置页修正后重载宿主）：${error.message}`,
      )
    }
  }
  validateInitialProxy()
  const readProxy = () => resolveProxy({ url: config.proxyUrl?.trim(), bypass: config.proxyBypass })
  const pluginFetch = createLiveProxiedFetch(readProxy)
  // 账号列表 / 当前账号：默认系统账号（真实 HOME，只读导入官方 CLI 登录态）；
  // 面板登录的新账号各自使用隔离 HOME，ACP server 与只读 CLI 都按该 HOME 启动。
  let accountsChanged = (): void => {}
  const accounts = new AccountsManager({
    baseDir: resolveAccountsDir(),
    homeDir: homedir(),
    fetchImpl: pluginFetch,
    resolveClient: async () => {
      if (config.agyCliPath === undefined) return resolveOAuthClient({ env: process.env, acpVersion })
      return resolveOAuthClient({ env: process.env, cliPath: config.agyCliPath, acpVersion })
    },
    writeCredentials: ({ home, client, tokens }) => writeAcpCredentialFiles(home, client, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(tokens.expiresAt === undefined ? {} : { expiry: new Date(tokens.expiresAt).toISOString() }),
    }).then(() => undefined),
    openBrowser: (url) => openDefaultBrowser(ctx.subprocess, url),
    onChange: () => accountsChanged(),
    log: {
      info: (message) => ctx.logger?.info?.(message),
      warn: (message, error) => ctx.logger?.warn?.(redactSensitiveText(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`)),
    },
  })
  // 代理地址可能刚被改坏：按 Promise 契约返回 rejected，让调用方各自的
  // 「取数失败折叠成可读错误」路径生效，而不是同步抛进调度器。
  const cliRun: ReturnType<typeof createSubprocessCliRun> = (request) => {
    let proxy: ResolvedProxy | undefined
    try {
      proxy = readProxy()
    } catch (error) {
      return Promise.reject(error)
    }
    const account = accounts.active()
    return createSubprocessCliRun(ctx.subprocess, proxy)({
      ...request,
      ...(account.dir ? { homeDir: account.dir } : {}),
    })
  }
  const findCli = () => agyCliCandidates(process.env, undefined, config.agyCliPath).find((candidate) => existsSync(candidate))
  let modelCatalogRevision = 0
  const catalogChanged = (): void => {
    modelCatalogRevision++
    // The host model picker subscribes to this existing registry notification.
    try { ctx.emit('llm/adapters-updated') } catch { /* Observers cannot veto catalog updates. */ }
  }
  ctx.on('loader/volatile-update', (paths) => {
    // 模型显示开关、默认档位与映射都会改变选择器与路由，需要通知宿主刷新目录。
    if (paths.some(([key]) => key === 'modelOverrides')) catalogChanged()
  })
  let attachmentStore: AttachmentStore | undefined

  /**
   * 官方模型清单：缓存先行（选择器即时可用），并在**后台**刷新一遍供下次生效。
   *
   * 没有任何缓存时也**不阻塞**：CLI 冷启动会做登录/配置刷新（实测可达数十秒），
   * 让模型选择器等它会把整个 GUI 拖住。这里后台取一次并立即返回空，取到后
   * 进程内缓存生效（刷新失败不重试，重启后再试）。
   */
  let cliModelRows: readonly { id: string; name: string }[] | undefined
  let cliDiskRead = false
  let cliRefresh: Promise<void> | undefined
  let cliRefreshDone = false
  const loadCliModels = async (force = false): Promise<readonly { id: string; name: string }[]> => {
    const cliPath = findCli()
    if (force && !cliPath) throw new Error('未找到官方 agy CLI，无法拉取模型；请先安装并登录官方 CLI')
    if (!cliDiskRead) {
      cliDiskRead = true
      const cached = await readCachedCatalog({ cacheDir, acpVersion, fileName: 'cli-models.json' })
      if (cached) cliModelRows = cached.models.map((row) => ({ id: row.id, name: row.name }))
    }
    if (cliPath && cliRefresh === undefined && (force || !cliRefreshDone)) {
      cliRefresh = (async () => {
        const models = await fetchAgyModels(cliRun, cliPath)
        if (models.length === 0) return
        await writeCachedCatalog({ cacheDir, acpVersion, fileName: 'cli-models.json', models })
        cliModelRows = models
        catalogChanged()
      })().finally(() => {
        cliRefresh = undefined
        cliRefreshDone = true
      })
      void cliRefresh.catch(() => ctx.logger?.warn?.('antigravity-acp: 模型目录刷新失败，保留已有目录'))
    }
    if (force) await cliRefresh
    return cliModelRows ?? []
  }

  // The store is lazy: no lock or file is opened until recovery is enabled and used.
  const sessionStore = createFileSessionMapStore(cacheDir,
    () => ctx.logger?.warn?.('antigravity-acp: 会话映射不可用或由另一 Host 占用，跨进程恢复已降级；不影响本地聊天'),
  )
  const workers: AntigravityAcpAdapter[] = []
  let metadata: AdapterMetadata | undefined
  // Serialize startup/credential preparation, not inference. This avoids competing OAuth imports.
  let startupBarrier: Promise<unknown> = Promise.resolve()
  const adapter = new ConversationWorkers(() => {
    const lifecycle = new AcpLifecycle()
    const active: ActiveAcpRuntime = { lifecycle }
    const workerIndex = workers.length
    const worker = new AntigravityAcpAdapter({
      lifecycle,
      // handler 对象由 adapter 构造时创建且身份稳定：AgentLink 只在构造时取一次
      // handlers，后续回合只更换 adapter 内部的当前回合。
      getLink: (handlers, signal, purpose) => {
        const launch = startupBarrier.catch(() => undefined).then(() => {
          signal?.throwIfAborted()
          const account = accounts.active()
          return ensureAcpRuntime(ctx, { ...config }, handlers, active, {
            signal,
            fetchImpl: pluginFetch,
            allowInteractiveAuth: purpose !== 'warmup' && workerIndex === 0,
            accountId: account.id,
            accountRevision: account.revision,
            ...(account.dir ? { accountHome: account.dir } : {}),
          })
        })
        startupBarrier = launch.then(() => undefined, () => undefined)
        return launch
      },
      recycleLink: (link) => recycleAcpRuntime(active, link),
      registerBridgeTeardown: (teardown) => {
        active.bridgeTeardown = teardown
      },
      promptTimeoutMs: config.promptTimeoutMs,
      sessionTimeoutMs: config.sessionTimeoutMs,
      parkSettleMs: config.bridgeParkSettleMs,
      modelOverrides: config.modelOverrides,
      readSettings: () => ({ ...config, sessionStore: config.resumeSessions ? sessionStore : undefined }),
      resumeSessions: config.resumeSessions,
      replayFallback: config.replayFallback,
      replayMaxChars: config.replayMaxChars,
      cancelGraceMs: config.cancelGraceMs,
      idleRecycleMs: config.idleRecycleMs,
      sessionStore: config.resumeSessions ? sessionStore : undefined,
      canReadImages: () => attachmentStore !== undefined,
      readImage: (ref, signal) => {
        if (!attachmentStore) throw new LlmError('宿主附件服务不可用，无法读取图片', 'AGY_IMAGE_UNAVAILABLE')
        return attachmentStore.readImage(ref, signal)
      },
      onMetadataChanged: (snapshot) => {
        metadata = snapshot
        for (const peer of workers) if (peer !== worker) peer.importMetadata(snapshot)
        catalogChanged()
      },
      // 冷启动目录：真实目录只能观测到之后才有，先用磁盘缓存兜住模型选择器。
      agentMode: config.agentMode,
      loadCachedCatalog: () => readCachedCatalog({ cacheDir, acpVersion }),
      saveCatalog: (catalog) => writeCachedCatalog({ cacheDir, acpVersion, ...catalog }),
      // 官方清单补齐会话观测之外的型号（Opus 5.5 / Sonnet 5.5 / Argon 等）。
      loadCliCatalog: () => loadCliModels(),
      // 自诊断：模型路由与 set_config_option 失败会写进宿主日志（宿主对 typert /
      // 适配器内部一律不记日志，出问题时这是唯一的现场）。
      log: {
        info: (message: string) => ctx.logger?.info?.(message),
        warn: (message: string, error?: unknown) => ctx.logger?.warn?.(redactSensitiveText(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`)),
      },
    })
    if (metadata) worker.importMetadata(metadata)
    workers.push(worker)
    return {
      adapter: worker,
      ensureImages: (signal) => worker.prepareImages(signal),
      read: () => lifecycle.read(),
      dispose: () => disposeAcpRuntime(active),
    }
  }, {
    // 同一 DSH 对话必须粘在同一个 worker：ACP 会话记录在 worker 内部，换 worker 即丢失。
    sessionAffinity: true,
  })
  ctx.inject(['attachments'], (scope) => {
    const store = scope.attachments
    attachmentStore = store
    adapter.invalidatePreparation()
    catalogChanged()
    scope.effect(() => () => {
      if (attachmentStore === store) {
        attachmentStore = undefined
        adapter.invalidatePreparation()
        catalogChanged()
      }
    })
  })
  accountsChanged = () => {
    catalogChanged()
    adapter.invalidatePreparation()
  }
  const control = new SettingsControl({
    runtime: () => ({ ...adapter.read(), modelCatalogRevision }),
    warmup: (signal) => adapter.warmup(signal),
    connect: async (signal) => {
      await adapter.discoverModels(signal)
    },
    models: async (force) => {
      // ACP 连接现在按需建立，设置页打开时可能还没有会话目录；官方 CLI 的
      // `agy models` 是独立的只读来源，先合并它，避免模型页空白。
      let cli: readonly { id: string; name: string }[] = []
      if (findCli()) cli = await loadCliModels(force)
      else if (force) await adapter.discoverModels(undefined, false)
      const acp = await adapter.listModels(AGY_PROVIDER_ID)
      // CLI 清单是档位化原始行：先折叠成家族再合并，模型页才不会按思考档位分行。
      return mergeModelRows(AGY_PROVIDER_ID, acp, cli)
    },
  })

  // 宿主销毁会话时，释放对应的 ACP 会话与恢复映射——不再由插件自己猜清理时机。
  // 事件由 @deepseek-ai/dsh-session 声明；本包不依赖它的类型包，这里用最小形状绑定。
  const onSessionDisposed = ctx as unknown as {
    on(event: 'session/disposed', listener: (session: { id: string }) => void): void
  }
  onSessionDisposed.on('session/disposed', (session) => {
    try { adapter.releaseConversation(String(session.id)) }
    catch (error) { ctx.logger?.warn?.(`antigravity-acp: 释放已销毁会话失败 ${String(error)}`) }
  })

  const registration = ctx.llm.registerAdapter([AGY_PROVIDER_ID], adapter)

  // 额度监控：套餐额度取数服务 + Typert remote（供浏览器端药丸读取）。
  // 默认不调用本机 agy：套餐额度走 Cloud Code Assist HTTP（按账号 HOME）。
  // 仅当设置显式开启 cliQuotaEnabled 时才 spawn `agy -p /usage` 与 `/credits`
  // （AI Credits 只能这样读）。取数只读，凭据不写回、不进日志。
  registerAgYQuotaRemote(ctx)
  ctx.plugin(AgYQuotaService, {
    control,
    accounts,
    // HTTP 回退路径要从对应版本的缓存二进制里提取 OAuth client 元数据。
    deps: { acpVersion, cliPath: config.agyCliPath, fetchImpl: pluginFetch },
    cliQuotaEnabled: () => config.cliQuotaEnabled === true,
    resolveCli: () => { const cliPath = findCli(); return cliPath ? { run: cliRun, cliPath } : undefined },
    modelTarget: (model) => config.modelOverrides?.[model]?.target?.trim() || model,
    // 取数打点：浏览器侧无法写宿主日志，这条是「药丸有没有真的发请求、结果如何」的唯一现场。
    log: {
      info: (message: string) => ctx.logger?.info?.(message),
      warn: (message: string, error?: unknown) => ctx.logger?.warn?.(redactSensitiveText(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`)),
    },
  })

  // Config 的即时字段由 settings 投影；使用自定义卡片，不重复生成页面。
  // 弱依赖 settings，无 Web 的 profile 仍能加载。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as {
      configure: (opts: { auto: boolean }, fiber: unknown) => () => void
    }
    settingsCtx.effect(
      () => settings.configure({ auto: false }, ctx.fiber),
      'antigravity-acp: schema settings form',
    )
  })

  // cordis 4.x 的规范 dispose 挂点：generator effect，卸载时逆序执行。
  ctx.effect(function* () {
    yield () => registration()
    yield async () => control.dispose()
    yield async () => {
      try { await adapter.dispose() }
      finally {
        try { await accounts.dispose() }
        finally {
          try { await sessionStore?.close() }
          finally { await pluginFetch.close() }
        }
      }
    }
  }, 'antigravity-acp 生命周期清理')
  // 不再预热 ACP，也不预读二进制：首次聊天按需建立连接。
}
