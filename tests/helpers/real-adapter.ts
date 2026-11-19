/**
 * 真机 adapter 夹具：把**真实的** AntigravityAcpAdapter 接到真实 `agy acp`
 * 进程上（不经过 DSH 宿主、不经过 index.ts 的插件装配）。
 *
 * 用途：复现「ACP 会话复用 / 续轮」这类只可能在真实 agent 上出现的时序问题。
 * 默认 skip：只有 `AGY_REAL_ACP=1` 时用例才创建它，且每次创建都会消耗账号额度。
 *
 * 与生产路径的差异（刻意保持最小）：
 * - 进程经 `node:child_process` 直接 spawn，不走 `ctx.subprocess`
 *   （宿主 subprocess 服务需要 cordis Context 装配，与本次问题无关）；
 * - 工具走 adapter 自带的 loopback MCP 桥（与生产一致），只是由本夹具充当
 *   「DSH 工具执行器」把结果回喂。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLink, AGY_CLIENT_INFO, agentStreamFromSubprocess } from '../../src/protocol/agent-link.js'
import { AntigravityAcpAdapter } from '../../src/adapter/antigravity-adapter.js'
import type { AntigravityAcpAdapterOptions } from '../../src/adapter/antigravity-adapter.js'
import { AcpLifecycle } from '../../src/runtime/lifecycle.js'
import { createFileSessionMapStore } from '../../src/runtime/session-map.js'
import type { SessionMapStore } from '../../src/runtime/session-map.js'
import type { AgentLink as AgentLinkType } from '../../src/protocol/agent-link.js'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

export const REAL_ADAPTER_BIN = process.env.AGY_ACP_BIN ?? '/root/.local/bin/agy'

/** 把 node 子进程包成 adapter 需要的最小 SubprocessHandle 形状。 */
function handleFor(child: ChildProcess): SubprocessHandle {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    control: undefined,
    collected: {},
    done: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal } as never))),
    terminate: () => { child.kill('SIGTERM') },
    waitForExit: async () => {
      if (child.exitCode !== null) return true
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
      return true
    },
  } as unknown as SubprocessHandle
}

export interface RealAdapterLogLine { level: 'info' | 'warn'; message: string }

export interface RealAdapter {
  adapter: AntigravityAcpAdapter
  /** adapter 自己打的诊断日志（本轮复现的关键证据）。 */
  logs: RealAdapterLogLine[]
  /** 已建立的链路，便于用例直接观察。 */
  links: AgentLinkType[]
  cacheDir: string
  dispose(): Promise<void>
}

/**
 * 造一个真实的 adapter：每个 worker 一条独立 `agy acp` 进程，会话映射写临时目录。
 * @param options - 覆盖项（cwd、parkSettleMs、resumeSessions 等）。
 * @returns adapter 与其日志收集器。
 */
export async function createRealAdapter(
  options: Partial<AntigravityAcpAdapterOptions> & {
    cacheDir?: string
    /** 共享给多个 adapter 的映射存储（生产里同一插件实例的 worker 共用一份）。 */
    store?: SessionMapStore
    /** 外部传入 store 时默认不关闭它，由调用方负责。 */
    closeStore?: boolean
  } = {},
): Promise<RealAdapter> {
  const logs: RealAdapterLogLine[] = []
  const links: AgentLinkType[] = []
  const { store: sharedStore, closeStore, cacheDir: cacheOverride, ...adapterOverrides } = options
  const cacheDir = cacheOverride ?? await fs.mkdtemp(join(tmpdir(), 'agy-real-'))
  const store = sharedStore ?? createFileSessionMapStore(cacheDir, () => undefined)
  const ownsStore = sharedStore === undefined
  const children: ChildProcess[] = []
  const runtimeDir = await fs.mkdtemp(join(tmpdir(), 'agy-run-'))
  const lifecycle = new AcpLifecycle()
  let teardown: (() => Promise<void>) | undefined

  const getLink = async (
    handlers: Parameters<AntigravityAcpAdapterOptions['getLink']>[0],
    signal?: AbortSignal,
  ): Promise<AgentLinkType> => {
    signal?.throwIfAborted()
    lifecycle.starting()
    const child = spawn(REAL_ADAPTER_BIN, ['acp', '--dangerously-skip-permissions'], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        PATH: `${'/root/.local/bin'}:${process.env.PATH ?? ''}`,
        TEMP: runtimeDir,
        TMP: runtimeDir,
        TMPDIR: runtimeDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stderr?.resume()
    lifecycle.spawned()
    const link = new AgentLink({
      stream: agentStreamFromSubprocess(handleFor(child)),
      clientInfo: AGY_CLIENT_INFO,
      requestTimeoutMs: 120_000,
      handshakeTimeoutMs: 120_000,
      authTimeoutMs: 300_000,
      handlers,
    })
    links.push(link)
    link.start()
    await link.initialize({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    // 已登录时官方 server 自行完成认证；否则走 OAuth（真机环境下应已登录）。
    const tokenPath = join(process.env.HOME ?? '', '.gemini', 'antigravity-acp', 'acp_token.json')
    const ready = await fs.access(tokenPath).then(() => true, () => false)
    if (!ready) await link.authenticate()
    lifecycle.ready()
    return link
  }

  const adapter = new AntigravityAcpAdapter({
    lifecycle,
    getLink,
    recycleLink: async (link) => { await link.close().catch(() => undefined); lifecycle.recycling(); lifecycle.stopped() },
    registerBridgeTeardown: (fn) => { teardown = fn },
    sessionStore: store,
    resumeSessions: true,
    cancelGraceMs: 5_000,
    idleRecycleMs: 0,
    cwd: options.cwd ?? process.cwd(),
    log: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message, error) => logs.push({
        level: 'warn',
        message: `${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`,
      }),
    },
    ...adapterOverrides,
  } as AntigravityAcpAdapterOptions)

  return {
    adapter,
    logs,
    links,
    cacheDir,
    async dispose() {
      await teardown?.().catch(() => undefined)
      for (const child of children) child.kill('SIGKILL')
      if (ownsStore && closeStore !== false) await store.close().catch(() => undefined)
    },
  }
}
