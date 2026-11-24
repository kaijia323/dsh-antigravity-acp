import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 组件返回的元素树节点（createElement 桩的产物）；条件渲染时可能返回 null。 */
interface StubElement {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

type StubComponent = (props: Record<string, unknown>) => StubElement | null

interface SlotRegistration {
  row: {
    id: string
    name?: string
    order?: number
    inject?: (sessionId: string) => Record<string, unknown>
  }
  component: StubComponent
}

/** 在带最小 React 桩的上下文里加载 client.js，取出它注册的全部槽条目。 */
/** 最近一次 `loadRegistrations` 期间，组件写 state 时传入的值（按顺序）。 */
let lastStateCalls: unknown[] = []
const effectCleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of effectCleanups.splice(0)) cleanup() })

/** 最近一次 `loadRegistrations` 期间，各处 `ctx.inject([...])` 声明的依赖列表。 */
let lastInjectDeps: string[][] = []
let latestStateValues: unknown[] = []

/** 最近一次 `loadRegistrations` 期间，`ctx.remote.$mount(...)` 收到的 remote 声明。 */
let lastMountCalls: Array<{ package?: string; descriptors?: Array<{ id?: string; method?: string }> }> = []

/** 注入的额度 remote 替身：药丸会 `scope.get('remote.agyQuota')` 后再 `.read()`。 */
interface QuotaStubOptions {
  /** 返回 remote 的原始回包（**未拆信封**），与真实网关一致。 */
  quotaRead?: () => Promise<unknown>
  models?: (request?: { force?: boolean }) => Promise<unknown>
  /**
   * 注入会话模型目录的当前 provider。药丸只在 provider 匹配时取数，因此要驱动
   * 取数链路就必须把它设成 `antigravity-acp`；缺省保持空快照（渲染即 null）。
   */
  quotaProvider?: string
  quotaSnapshot?: unknown
  stateOverrides?: Record<number, unknown>
  immediateUnmount?: boolean
  refOverrides?: Record<number, unknown>
  refStateBindings?: Record<number, number>
  listeners?: Map<string, (event: { key?: string; target?: unknown }) => void>
}

function loadRegistrations(options: QuotaStubOptions = {}): Map<string, SlotRegistration> {
  lastStateCalls = []
  latestStateValues = []
  lastInjectDeps = []
  lastMountCalls = []
  let registration: {
    factory: (require: (id: string) => unknown) => { apply: (ctx: Record<string, unknown>) => void }
  } | undefined
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: unknown) => { registration = value as typeof registration } }, innerHeight: 844,
      addEventListener: (type: string, fn: (event: { key?: string; target?: unknown }) => void) => options.listeners?.set(type, fn),
      removeEventListener: (type: string) => options.listeners?.delete(type),
    },
    // vm 上下文没有浏览器/Node 宿主 API；药丸的轮询定时器需要显式注入。
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    document: {
      documentElement: { clientWidth: 375 },
      addEventListener: (type: string, fn: (event: { key?: string; target?: unknown }) => void) => options.listeners?.set(type, fn),
      removeEventListener: (type: string) => options.listeners?.delete(type),
    },
  })
  if (!registration) throw new Error('client.js 未向 __ModuleLoader__ 注册')

  let stateIndex = 0
  let refIndex = 0
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
      if (typeof type === 'function') {
        const rendered = (type as StubComponent)({ ...(props ?? {}), children: children.flat() })
        return rendered ?? { type: 'fragment', props: {}, children: [] }
      }
      return { type, props: props ?? {}, children: children.flat() }
    },
    // 记录 setState 的入参：额度链路「拆信封」的回归就靠它断言。
    useState: (initial: unknown) => {
      const index = stateIndex++
      const value = options.stateOverrides && index in options.stateOverrides ? options.stateOverrides[index]
        : initial === null && options.quotaSnapshot !== undefined ? options.quotaSnapshot : initial
      latestStateValues[index] = value
      return [value, (next: unknown) => {
        const resolved = typeof next === 'function' ? (next as (previous: unknown) => unknown)(latestStateValues[index]) : next
        latestStateValues[index] = resolved
        lastStateCalls.push(resolved)
      }]
    },
    useCallback: <T,>(fn: T) => fn,
    // 维持挂载直到 afterEach；立即卸载必须显式选择，不能期待卸载后仍 setState。
    useEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') {
        if (options.immediateUnmount) cleanup()
        else effectCleanups.push(cleanup)
      }
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useId: () => 'test',
    useMemo: <T,>(fn: () => T) => fn(),
    useRef: <T,>(initial: T) => {
      const index = refIndex++
      const stateIndex = options.refStateBindings?.[index]
      return { get current() { return stateIndex === undefined ? options.refOverrides?.[index] ?? initial : latestStateValues[stateIndex] } }
    },
  }

  const registrations = new Map<string, SlotRegistration>()
  const mountedPackages = new Set<string>()
  const slots = {
    inject: (_name: string, factory: () => unknown) => {
      factory()
      return () => {}
    },
    register: (row: SlotRegistration['row'], target: StubComponent) => {
      registrations.set(row.id, { row, component: (props) => { stateIndex = 0; refIndex = 0; return target(props) } })
      return () => {}
    },
  }
  const scope = {
    slots,
    effect: (fn: () => () => void) => {
      fn()
      return () => {}
    },
    inject: (deps: unknown, fn: (child: unknown) => void) => {
      lastInjectDeps.push(Array.isArray(deps) ? (deps as string[]) : [])
      fn(scope)
      return () => {}
    },
    get: (name: string) =>
      name === 'remote.agyQuota' && (options.quotaRead || options.models)
        ? { read: options.quotaRead, models: options.models } : undefined,
    // 忠实模拟 cordis 的 ReflectService：读取**未 inject** 的 `remote.<ns>` 属性会抛
    // 「cannot get property "remote.<ns>" without inject」。贡献型 remote 不进 inject，
    // 因此组件只能走 `ctx.get('remote.<ns>')`；这条替身行为让写错的一行在测试里就暴露。
    remote: new Proxy(
      {
        $mount: (declaration: unknown) => {
            const descriptor = declaration as (typeof lastMountCalls)[number]
            if (!descriptor.package || mountedPackages.has(descriptor.package)) throw new Error('typert: Remote package is already registered')
            mountedPackages.add(descriptor.package)
            lastMountCalls.push(descriptor)
          return Promise.resolve(() => {})
        },
      },
      {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && prop in target) return Reflect.get(target, prop, receiver)
          throw new Error(`cannot get property "remote.${String(prop)}" without inject`)
        },
      },
    ),
    modelDirectories: {
      directoryFor: () => ({
        store: {
          subscribe: () => () => {},
          getSnapshot: () => (options.quotaProvider ? { current: { provider: options.quotaProvider } } : {}),
        },
      }),
    },
  }
  const plugin = registration.factory(() => react)
  plugin.apply(scope)
  return registrations
}

/** 取设置卡片（settings.section 槽，id=antigravity-acp）。 */
function loadCard(): StubComponent {
  const card = loadRegistrations().get('antigravity-acp')?.component
  if (!card) throw new Error('client.js 未注册 settings.section 卡片')
  return card
}

/** 取额度药丸（conversation.input.right 槽，id=antigravity-quota）。 */
function loadPill(): { component: StubComponent; row: SlotRegistration['row'] } {
  const entry = loadRegistrations().get('antigravity-quota')
  if (!entry) throw new Error('client.js 未注册额度药丸')
  return entry
}

/** 收集卡片里所有文本节点，用于断言渲染出的说明文案。 */
function texts(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') into.push(node)
  else if (node && typeof node === 'object') {
    for (const child of (node as StubElement).children ?? []) texts(child, into)
  }
  return into
}

function elements(node: unknown): StubElement[] {
  if (!node || typeof node !== 'object') return []
  const value = node as StubElement
  return [value, ...(value.children ?? []).flatMap(elements)]
}
function pillLabel(node: unknown): string {
  return String(elements(node).find((item) => item.props.role === 'status')?.props['aria-label'] ?? '')
}

/** 构造模型目录 store 快照（决定药丸是否出现）。 */
function modelStore(provider: string | null) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: provider ? 'ready' : 'loading', current: provider ? { provider } : null }),
  }
}

describe('browser client module', () => {
  it('设置页不再提供手动预热或连接，模型目录自动读取', async () => {
    const control = vi.fn(async (method: string, request?: { action?: string; force?: boolean }) => method === 'account'
      ? {
        state: 'idle', message: 'test',
        activeAccountId: 'primary', auth: { phase: 'idle' },
        accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: false, createdAt: 0 }],
      }
      : { status: 'ok', models: [{ id: 'gemini-example', name: 'Gemini Example' }] })
    const readQuota = vi.fn(async () => ({ status: 'ok', groups: [] }))
    const snapshot = {
      state: 'idle', message: 'test', activeAccountId: 'primary', auth: { phase: 'idle' },
      accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: false, createdAt: 0 }],
    }
    const card = loadRegistrations({ stateOverrides: { 0: snapshot } }).get('antigravity-acp')!.component
    const tree = card({ remote: {}, control, readQuota })
    const text = texts(tree).join(' ')
    expect(text).toContain('添加账号')
    expect(elements(tree).some(item => item.props['aria-label'] === '模型列表')).toBe(true)
    expect(text).not.toContain('首次')
    expect(control.mock.calls.some(([, request]) => request?.action === 'login')).toBe(false)
    expect(readQuota).toHaveBeenCalled()
    expect(texts(tree).join(' ')).not.toContain('AI Credits 余额')
  })

  it('设置页按任务分区，账号页合并连接与额度', () => {
    const control = vi.fn(async (method: string) => method === 'account'
      ? {
        state: 'idle', message: 'ready', activeAccountId: 'primary', auth: { phase: 'idle' },
        accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 }],
      }
      : { status: 'ok', models: [] })
    const snapshot = {
      state: 'idle', message: 'ready', activeAccountId: 'primary', auth: { phase: 'idle' },
      accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 }],
    }
    const card = loadRegistrations({ stateOverrides: { 0: snapshot } }).get('antigravity-acp')!.component
    const tree = card({ remote: {}, control, readQuota: async () => ({ status: 'ok', groups: [] }) })
    const text = texts(tree).join(' ')
    for (const label of ['账号', '模型', '添加账号']) expect(text).toContain(label)
    // 连接与额度不再是两个分页：账号卡片内给出登录 / 切换与手动额度。
    const tabs = elements(tree).filter((item) => item.props.role === 'tab')
    expect(tabs.map((item) => texts(item).join(''))).toEqual(['账号', '模型'])
    expect(tabs.find((item) => texts(item).join('') === '账号')?.props['aria-selected']).toBe(true)
    expect(text).toContain('添加账号')
    // 默认模型由 DSH 自己的模型选择器负责，设置页不再重复维护。
    expect(text).not.toContain('默认模型')
    expect(text).not.toContain('套餐额度管理')
    expect(elements(tree).filter((item) => item.props['aria-label'] === 'AI Credits 余额')).toHaveLength(0)
    // 普通配置不是即时字段，卡片不再渲染说明块；三个分组 details 仍保留。
    expect(text).not.toContain('普通配置（并发 / 二进制 / 超时）')
    expect(elements(tree).filter((item) => item.type === 'details')).toHaveLength(0)
  })

  it('目录冷启动超过 60 秒时客户端继续等待 Host，而不是提前报超时', async () => {
    vi.useFakeTimers()
    try {
      let complete!: (value: unknown) => void
      const models = vi.fn(() => new Promise<unknown>((resolve) => { complete = resolve }))
      const settings = loadRegistrations({ models }).get('antigravity-acp')!.row.inject!('')
      const control = settings.control as (method: string, request?: { force?: boolean }) => Promise<unknown>
      let settled = false
      const pending = control('models', { force: true }).then((value) => { settled = true; return value })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).toBe(false)
      expect(models).toHaveBeenCalledWith({ force: true })
      const snapshot = { status: 'ok', models: [{ id: 'example', name: 'Example' }] }
      complete(snapshot)
      expect(await pending).toEqual(snapshot)
    } finally { vi.useRealTimers() }
  })

  it('设置页和药丸使用同一额度读取器，刷新可通知其它视图', async () => {
    const snapshot = { status: 'ok', groups: [] }
    const registrations = loadRegistrations({ quotaRead: async () => ({ ok: true, value: snapshot }) })
    const settings = registrations.get('antigravity-acp')!.row.inject!('')
    const pill = registrations.get('antigravity-quota')!.row.inject!('s')
    expect(settings.readQuota).toBe(pill.readQuota)
    const reader = pill.readQuota as ((force: boolean) => Promise<unknown>) & { subscribe(fn: (value: unknown) => void): () => void }
    const changed = vi.fn()
    const off = reader.subscribe(changed)
    await reader(true)
    expect(changed).toHaveBeenCalledWith(snapshot)
    off()
    await reader(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('出网代理不再占设置项，由系统代理检测兜底', () => {
    const tree = loadCard()({ remote: {} })
    const text = texts(tree).join('')
    expect(text).not.toContain('出网代理')
  })

  it('returns its plugin exports when the DSH loader supplies only require', () => {
    let registration: {
      id: string
      factory: (require: (id: string) => unknown) => {
        name: string
        inject: string[]
        apply: (ctx: unknown) => void
      }
    } | undefined
    const requireModule = (id: string) => {
      expect(id).toBe('react')
      return { createElement() {} }
    }

    runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
      window: {
        __ModuleLoader__: {
          load(value: NonNullable<typeof registration>) {
            registration = value
          },
        },
      },
    })

    expect(registration?.id).toBe('dsh-bundle-antigravity-acp')
    const plugin = registration!.factory(requireModule)
    expect(plugin.name).toBe('dsh-bundle-antigravity-acp')
    // remote.settings / remote.llm 必须逐个声明：缺任一项时读属性会抛
    // 「cannot get property "remote.<ns>" without inject」并击穿 settings.section。
    expect(plugin.inject).toEqual(['slots', 'remote', 'remote.settings', 'remote.llm'])
    expect(plugin.apply).toBeTypeOf('function')
  })

  it('设置卡片只经 settings.describe/listProviders 取数，绝不调用宿主不存在的 llm.listModels', async () => {
    const Card = loadCard()
    const calls = { describe: 0, listProviders: 0, listModels: 0, on: [] as string[] }
    const remote = {
      settings: {
        describe: async () => {
          calls.describe += 1
          return {
            ok: true,
            value: {
              writable: true,
              namespaces: [
                { ns: 'llm-antigravity-acp', revision: 7, value: { proxyUrl: '', modelOverrides: { 'gemini-3-pro': { effort: 'high' } } } },
              ],
            },
          }
        },
      },
      llm: {
        listProviders: async () => {
          calls.listProviders += 1
          return { ok: true, value: [{ id: 'antigravity-acp', name: 'Antigravity (ACP)' }] }
        },
        // 真实宿主没有这个方法；一旦卡片回退到它，这里会被调用并让断言失败。
        listModels: async () => {
          calls.listModels += 1
          return []
        },
      },
      $on: (name: string) => {
        calls.on.push(name)
        return () => {}
      },
    }

    Card({ remote })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.describe).toBeGreaterThanOrEqual(1)
    expect(calls.listProviders).toBeGreaterThanOrEqual(1)
    expect(calls.listModels).toBe(0)
    // 配置变更后应自动刷新卡片。
    expect(calls.on).toContain('settings/document-updated')
  })

  it('provider 已注册时账号页显示未连接而不是「路由未注册」', async () => {
    const Card = loadCard()
    const remote = {
      settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }) },
      llm: { listProviders: async () => ({ ok: true, value: [{ id: 'antigravity-acp' }] }) },
      $on: () => () => {},
    }

    const tree = Card({ remote })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // 没有真实目录来源时，卡片如实说明「未找到本路由」，而不是编造模型列表。
    expect(texts(tree).join('\n')).not.toContain('路由未注册')
    expect(texts(tree).join('\n')).toContain('添加账号')
  })

  it('宿主缺少 settings.describe 时降级为可读提示而不是崩溃', () => {
    const Card = loadCard()
    const tree = Card({ remote: {} })
    expect(texts(tree).join('\n')).toContain('添加账号')
  })

  it('remote.<ns> 属性访问抛「without inject」时降级，绝不把异常抛出组件', () => {
    const Card = loadCard()
    // 复现宿主 ReflectService 的行为：缺 inject 时连读属性都会抛。
    const denied = (ns: string) => {
      throw new Error(`cannot get property "${ns}" without inject`)
    }
    const remote = {
      get settings() {
        return denied('remote.settings')
      },
      get llm() {
        return denied('remote.llm')
      },
      $on: () => () => {},
    }

    // 异常若穿出组件，React 侧会击穿 settings.section 卡片并弄坏设置页。
    expect(() => Card({ remote })).not.toThrow()
    const tree = Card({ remote })
    expect(texts(tree).join('\n')).toContain('添加账号')
  })
})

describe('AI Credits 展示', () => {
  it('胶囊不再承载 AI Credits：明细已移到设置页额度块', () => {
    const data = { status: 'ok', groups: [], credits: { status: 'ok', remainingCredits: 42 } }
    const tree = loadRegistrations({ quotaSnapshot: data }).get('antigravity-quota')!.component({ store: modelStore('antigravity-acp') })
    expect(elements(tree).filter((item) => item.props['aria-label'] === 'AI Credits 余额')).toHaveLength(0)
  })
})

describe('额度药丸（conversation.input.right）', () => {
  it('药丸是纯展示：没有按钮、没有弹层，也不启动 ACP', () => {
    const control = vi.fn()
    const { component } = loadPill()
    const tree = component({ store: modelStore('antigravity-acp'), control })
    expect(elements(tree).filter((item) => item.type === 'button')).toHaveLength(0)
    expect(elements(tree).filter((item) => item.props.role === 'dialog')).toHaveLength(0)
    expect(elements(tree).find((item) => item.props.role === 'status')?.props.style).toMatchObject({ minHeight: '26px', maxWidth: 'min(52vw, 260px)' })
    expect(control).not.toHaveBeenCalled()
  })

  it('其他 provider 不显示预热按钮，也不读取 ACP 状态', () => {
    const control = vi.fn()
    expect(loadPill().component({ store: modelStore('deepseek-official'), control })).toBeNull()
    expect(control).not.toHaveBeenCalled()
  })

  it('药丸不注入 ACP 设置控制器', () => {
    const entries = loadRegistrations()
    expect(entries.get('antigravity-quota')!.row.inject!('session')).not.toHaveProperty('control')
  })

  const completeQuota = { status: 'ok', groups: [
    { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 82 }, { window: 'weekly', remainingPct: 71 }] },
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 43 }] },
    { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingPct: 12 }] },
  ] }

  it('药丸显示选中模型家族的族名 + 百分比 + 迷你条', () => {
    const props = { store: { ...modelStore('antigravity-acp'), getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'gemini-4-argon-high' } }) } }
    const tree = loadRegistrations({ quotaSnapshot: completeQuota }).get('antigravity-quota')!.component(props)
    const text = texts(tree).join(' ')
    expect(text).toContain('Gemini 4 Argon')
    expect(text).toContain('12%')
    // 只有当前家族那一组窗口的迷你条。
    const bars = elements(tree).filter((item) => item.props.role === 'progressbar')
    expect(bars).toHaveLength(1)
    expect(bars[0]?.props['aria-valuenow']).toBe(12)
    expect(pillLabel(tree)).toBe('Gemini 4 Argon 12% · 每周 12% 剩余')
  })

  it('未知自定义模型不借用其它模型额度；缓存状态与禁用窗口有明确语义', () => {
    const pill = loadRegistrations({ quotaSnapshot: { ...completeQuota, stale: true } }).get('antigravity-quota')!.component
    const tree = pill({ store: { ...modelStore('antigravity-acp'), getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'custom-id' } }) } })
    expect(pillLabel(tree)).toContain('未知')
    expect(pillLabel(tree)).toContain('缓存数据')
    expect(elements(tree).filter((item) => item.props.role === 'progressbar')).toHaveLength(0)
  })

  it('挂载后立即卸载不接收迟到的额度响应', async () => {
    const entry = loadRegistrations({ immediateUnmount: true }).get('antigravity-quota')!
    entry.component({ store: modelStore('antigravity-acp'), readQuota: async () => completeQuota })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastStateCalls).not.toContainEqual(completeQuota)
  })

  it('同 provider 切换型号时仅显示对应家族的额度条，百分比留在无障碍标签', () => {
    const quotaSnapshot = { status: 'ok', groups: [
      { name: 'Gemini Models', buckets: [{ name: '5h', window: '5h', remainingPct: 90 }] },
      { name: 'Gemini 4 Argon', buckets: [{ name: '5h', window: '5h', remainingPct: 2 }] },
      { name: 'Claude / GPT Models', buckets: [
        { name: '5h', window: '5h', remainingPct: 60 },
        { name: 'weekly', window: '7d', remainingPct: 10 },
      ] },
    ] }
    const pill = loadRegistrations({ quotaSnapshot }).get('antigravity-quota')!.component
    let model = 'gemini-flash'
    const store = { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model } }) }
    const props = { store, readQuota: async () => quotaSnapshot }
    expect(pillLabel(pill(props))).toContain('90%')
    model = 'claude-opus'
    const switched = pillLabel(pill(props))
    expect(switched).toContain('10%')
    expect(switched).not.toContain('90%')
    model = 'gemini-4-argon'
    expect(pillLabel(pill(props))).toContain('2%')
    model = 'server-default'
    expect(pillLabel(pill(props))).toContain('未知')
  })

  const twoPoolQuota = { status: 'ok', groups: [
    { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 82 }, { window: 'weekly', remainingPct: 71 }] },
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 43 }] },
  ] }

  /**
   * 2026-11-24 起 Google 只返回两池（Gemini Models / Claude and GPT models），Argon 并进 Gemini 池；
   * 药丸必须读共享的 Gemini 窗口，而不是继续等一个已经不存在的独立 Argon 组。
   */
  it('两池响应下 Argon 药丸读取共享的 Gemini 池（族名 + 最低窗口 + 迷你条）', () => {
    for (const model of ['gemini-4-argon', 'gemini-4-argon-high']) {
      const store = { ...modelStore('antigravity-acp'), getSnapshot: () => ({ current: { provider: 'antigravity-acp', model } }) }
      const tree = loadRegistrations({ quotaSnapshot: twoPoolQuota }).get('antigravity-quota')!.component({ store })
      // 族名是 Gemini，数值取 Gemini 池里最低的窗口 71%，不再是「未知」。
      expect(pillLabel(tree)).toBe('Gemini 71% · 5 小时 82% 剩余 · 每周 71% 剩余')
      expect(pillLabel(tree)).not.toContain('未知')
      const bars = elements(tree).filter((item) => item.props.role === 'progressbar')
      expect(bars.map((bar) => bar.props['aria-valuenow'])).toEqual([82, 71])
      expect(bars).toHaveLength(2)
    }
  })

  it('两池响应下未知模型仍显示「未知」，绝不借用 Gemini / Claude 额度', () => {
    for (const model of ['custom-id', 'server-default']) {
      const store = { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model } }) }
      const tree = loadRegistrations({ quotaSnapshot: twoPoolQuota }).get('antigravity-quota')!.component({ store })
      expect(pillLabel(tree)).toContain('未知')
      expect(pillLabel(tree)).not.toContain('71%')
      expect(pillLabel(tree)).not.toContain('43%')
      expect(elements(tree).filter((item) => item.props.role === 'progressbar')).toHaveLength(0)
    }
  })

  it('遗留三池响应下 Argon 仍读独立组，不污染 Gemini 池', () => {
    const store = { ...modelStore('antigravity-acp'), getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'gemini-4-argon-high' } }) }
    const legacy = { ...twoPoolQuota, groups: [...twoPoolQuota.groups, { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingPct: 12 }] }] }
    const separate = loadRegistrations({ quotaSnapshot: legacy }).get('antigravity-quota')!.component({ store })
    expect(pillLabel(separate)).toBe('Gemini 4 Argon 12% · 每周 12% 剩余')
    expect(pillLabel(separate)).not.toContain('82%')
    expect(pillLabel(separate)).not.toContain('71%')
  })

  it('额度百分比缺失不能显示为零额度', () => {
    const quotaSnapshot = { status: 'ok', groups: [{ name: 'Gemini', buckets: [{ name: '5h' }] }] }
    const pill = loadRegistrations({ quotaSnapshot }).get('antigravity-quota')!.component
    const store = { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'gemini-flash' } }) }
    const label = pillLabel(pill({ store, readQuota: async () => quotaSnapshot }))
    expect(label).toContain('额度未知')
    expect(label).not.toContain('0%')
  })

  it('注册在模型选择器左侧的槽位，带稳定 id 与 order', () => {
    const { row } = loadPill()
    expect(row.name).toBe('conversation.input.right')
    expect(row.id).toBe('antigravity-quota')
    expect(row.order).toBeTypeOf('number')
  })

  it('当前模型不是 antigravity-acp 时不渲染', () => {
    const { component } = loadPill()
    expect(component({ store: modelStore('deepseek-official'), readQuota: async () => ({}) })).toBeNull()
    expect(component({ store: modelStore(null), readQuota: async () => ({}) })).toBeNull()
  })

  it('选中 antigravity-acp 时渲染药丸并在挂载时取数', async () => {
    const { component } = loadPill()
    const calls: boolean[] = []
    const tree = component({
      store: modelStore('antigravity-acp'),
      readQuota: async (force?: boolean) => {
        calls.push(Boolean(force))
        return { status: 'ok', updatedAt: new Date().toISOString(), groups: [] }
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(tree).not.toBeNull()
    expect(pillLabel(tree)).toContain('额度')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('取数失败降级为可读文案，不把异常抛出组件', async () => {
    const { component } = loadPill()
    const boom = async () => {
      throw new Error('额度服务未就绪（Host 端 remote.agyQuota 未挂载）')
    }
    let tree: StubElement | null = null
    expect(() => {
      tree = component({ store: modelStore('antigravity-acp'), readQuota: boom })
    }).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(tree).not.toBeNull()
  })

  it('切到其它 provider 时清掉旧额度数据（切回不闪旧值）', async () => {
    const { component } = loadPill()
    const readQuota = async (): Promise<unknown> => ({
      status: 'ok',
      updatedAt: new Date().toISOString(),
      groups: [],
    })
    component({ store: modelStore('antigravity-acp'), readQuota })
    await Promise.resolve()
    await Promise.resolve()
    component({ store: modelStore('deepseek-official'), readQuota })
    // 清状态走 setData(null)；修复前旧快照会一直留到下一次取数。
    expect(lastStateCalls).toContain(null)
  })
})

/**
 * 额度药丸的 remote 回包拆信封（2026-10-17 回归）。
 *
 * 实测：Typert remote 的一元调用回包是 `{ ok, value }`（宿主上正常工作的
 * dsh-subusage 客户端同样先查 `response.ok` 再读 `response.value`）。药丸早先直接
 * `setData(结果)`，信封没拆 → `data.status` 恒为 undefined → 标签永远停在
 * 「额度…」、面板正文渲染成空。这里把「拆了」固化下来。
 */
describe('额度药丸：remote 回包拆信封', () => {
  const snapshot = {
    status: 'ok',
    updatedAt: '2026-10-17T00:00:00.000Z',
    plan: 'Antigravity',
    groups: [
      {
        name: 'Gemini Models',
        buckets: [{ name: 'Five Hour Limit Remaining', window: '5h', remainingPct: 98.55, disabled: false }],
      },
    ],
  }

  /** 等两轮微任务，让 readQuota → setData 链路跑完。 */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('ok 信封：写入 state 的是 value 本身，而不是信封', async () => {
    const entry = loadRegistrations({ quotaRead: async () => ({ ok: true, value: snapshot }), quotaProvider: 'antigravity-acp' }).get('antigravity-quota')
    if (!entry) throw new Error('未注册额度药丸')
    // 药丸的 readQuota 来自槽位注入（与真实宿主一致）：先取注入面，再以它渲染。
    const inject = entry.row.inject
    if (typeof inject !== 'function') throw new Error('额度药丸槽位未声明 inject')
    const props = inject('session-1') as {
      store: unknown
      readQuota: (force?: boolean) => Promise<unknown>
    }
    entry.component(props)
    await settle()
    // 断言：写进 state 的是拆开后的快照（带 status/groups），而不是 { ok, value } 信封。
    const written = [...lastStateCalls].reverse().find((value) => value !== null && typeof value === 'object' && 'status' in value) as Record<string, unknown>
    expect(written.status).toBe('ok')
    expect(written.groups).toEqual(snapshot.groups)
    expect(written).not.toHaveProperty('ok')
  })

  it('失败信封：失败调用不通知其它药丸覆盖成功快照', async () => {
    const entry = loadRegistrations({
      quotaRead: async () => ({ ok: false, error: { message: 'remote denied' } }),
      quotaProvider: 'antigravity-acp',
    }).get('antigravity-quota')
    if (!entry) throw new Error('未注册额度药丸')
    const inject = entry.row.inject
    if (typeof inject !== 'function') throw new Error('额度药丸槽位未声明 inject')
    const props = inject('session-1') as {
      store: unknown
      readQuota: ((force?: boolean) => Promise<unknown>) & { subscribe(listener: (value: unknown) => void): () => void }
    }
    const listener = vi.fn()
    const off = props.readQuota.subscribe(listener)
    await expect(props.readQuota(false)).rejects.toThrow('remote denied')
    expect(listener).not.toHaveBeenCalled()
    off()
  })
})

/**
 * 贡献型 remote 的客户端挂载（2026-10-17 回归）。
 *
 * 实测契约（对照同宿主上正常工作的 dsh-subusage）：贡献型 remote 必须在客户端显式
 * `ctx.remote.$mount({ package, descriptors })`，之后 `ctx.get("remote.<ns>")` 才查得到。
 * 只做 Host 侧注册而漏挂载 → 药丸永远等不到服务（空着）；把 `remote.<ns>` 写进 inject
 * 等它出现 → 注入永不满足，**药丸彻底消失**。两条都踩过，这里把它们钉住。
 */
describe('额度药丸：remote 客户端挂载', () => {
  it('apply 时以本包名义 $mount，且 descriptor 指向 agyQuota/read', () => {
    loadRegistrations()
    expect(lastMountCalls).toHaveLength(1)
    const call = lastMountCalls[0]!
    expect(call.descriptors?.map(item => item.id)).toEqual([
      'dsh-bundle-antigravity-acp#agyQuota/read',
      'dsh-bundle-antigravity-acp#agyQuota/account',
      'dsh-bundle-antigravity-acp#agyQuota/models',
    ])
    expect(call.package).toBe('dsh-bundle-antigravity-acp')
    expect(call.descriptors?.[0]?.id).toBe('dsh-bundle-antigravity-acp#agyQuota/read')
    expect(call.descriptors?.[0]?.method).toBe('read')
  })

  it('药丸的 inject 不得依赖 remote.agyQuota（否则注入永不满足、药丸消失）', () => {
    loadRegistrations()
    const requiresRemote = lastInjectDeps.some((deps) => deps.includes('remote.agyQuota'))
    expect(requiresRemote, `实际声明：${JSON.stringify(lastInjectDeps)}`).toBe(false)
    const registersPillWithoutRemote = lastInjectDeps.some(
      (deps) => deps.includes('slots') && deps.includes('modelDirectories'),
    )
    expect(registersPillWithoutRemote).toBe(true)
  })
})
