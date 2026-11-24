/**
 * Browser settings section for the Antigravity ACP bundle.
 * Loaded by DSH ModuleLoader; React is provided by the shell (do not bundle Node).
 *
 * Transport notes (verified against the installed shell contract, not guessed):
 * - `remote.settings.describe()` returns `{ writable, namespaces: [{ ns, value, revision }] }`.
 * - `remote.settings.mutate(entryId, ops, revision)` writes; ops are `{ op: 'set', path, value }`.
 * - `remote.llm.listProviders()` exists. There is **no** `remote.llm.listModels` in the
 *   shell, so the model catalogue cannot be fetched from here; it is surfaced through
 *   the host adapter (see src/adapter/antigravity-adapter.ts) and the plugin's own
 *   settings form instead.
 *
 * Inject contract (verified against the installed shell, 2026-10-16): each
 * `remote.<namespace>` face is its own injectable service. Reading it without a
 * matching entry in `inject` throws `cannot get property "remote.<ns>" without
 * inject` (Cordis ReflectService), which crashes this card inside the
 * `settings.section` slot and blanks the settings page. The shell's own client
 * plugins declare it the same way (`inject = ["remote", "remote.settings"]`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-bundle-antigravity-acp',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const PROVIDER = 'antigravity-acp'
    /** Settings namespace projected from Config's volatile fields in src/settings.ts. */
    const ENTRY_ID = 'llm-antigravity-acp'
    /** 逐模型设置：键是 DSH 选择器里的模型 ID，值是显示开关、显示名与官方 ID 映射。 */
    const OVERRIDES_KEY = 'modelOverrides'
    const OVERRIDES_LABEL = '模型列表设置'

    /** 只保留有意义的字段：启用是默认值，空串等于未设置。 */
    function canonicalOverride(row) {
      const source = row && typeof row === 'object' ? row : {}
      const result = {}
      if (source.enabled === false) result.enabled = false
      const name = typeof source.name === 'string' ? source.name.trim() : ''
      if (name) result.name = name
      const target = typeof source.target === 'string' ? source.target.trim() : ''
      if (target) result.target = target
      return result
    }
    /** 稳定序列化：键序不影响脏值判断。 */
    function canonicalOverrides(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const result = {}
      for (const key of Object.keys(source).sort()) {
        const row = canonicalOverride(source[key])
        if (Object.keys(row).length > 0) result[key] = row
      }
      return result
    }
    function sameOverrides(a, b) {
      return JSON.stringify(canonicalOverrides(a)) === JSON.stringify(canonicalOverrides(b))
    }
    function overrideFor(overrides, id) {
      const row = overrides && typeof overrides === 'object' ? overrides[id] : undefined
      return row && typeof row === 'object' ? row : {}
    }
    /** 目录条目 + 已配置但当前目录没有的 ID，都要能在此编辑。 */
    function modelRows(models, overrides) {
      const rows = models.map((model) => ({ id: model.id, name: model.name, inputModalities: model.inputModalities, inCatalog: true }))
      const known = new Set(rows.map((row) => row.id))
      for (const id of Object.keys(canonicalOverrides(overrides))) {
        if (!known.has(id)) rows.push({ id, name: id, inCatalog: false })
      }
      return rows
    }

    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return result.value
        throw new Error(result.error?.message || '未知错误')
      }
      return result
    }

    function StatusNotice({ status }) {
      if (!status) return null
      const error = status.kind === 'error'
      return h('p', { role: error ? 'alert' : 'status', style: { margin: 0, padding: '10px 12px', borderRadius: '10px', borderLeft: '3px solid ' + (error ? '#e5534b' : status.kind === 'busy' ? '#d99b28' : '#25b879'), fontSize: '12px', lineHeight: 1.6, overflowWrap: 'anywhere', color: 'inherit', background: error ? 'rgba(217,119,87,.10)' : status.kind === 'busy' ? 'rgba(217,155,40,.10)' : 'rgba(37,184,121,.10)' } }, status.text)
    }
    function SectionHeading({ title, action }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h3', { style: { fontSize: '14px', lineHeight: 1.4, fontWeight: 650, margin: 0 } }, title)),
        action ?? null)
    }
    /** 参考 dsh-agy-link：模型只做显示 / 隐藏，不再维护逐模型的思考档位、改名与官方 ID。 */
    function ModelChips({ rows, overrides, disabled, onEdit }) {
      if (rows.length === 0) {
        return h('p', { role: 'status', style: { margin: 0, fontSize: '12px', lineHeight: 1.5 } },
          '模型目录还没有可用模型，发一次对话后再来管理。')
      }
      const hidden = rows.filter((row) => overrideFor(overrides, row.id).enabled === false).length
      const families = [
        ...GROUPS.map((group) => ({ ...group, rows: rows.filter((row) => modelGroup(row.id) === group.key) })),
        { key: 'other', name: '其它', rows: rows.filter((row) => modelGroup(row.id) === undefined) },
      ].filter((group) => group.rows.length > 0)
      const chips = (list) => h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, ...list.map((row) => {
        const isHidden = overrideFor(overrides, row.id).enabled === false
        const title = row.id + (row.inCatalog ? '' : ' · 不在当前目录')
        return h('button', {
          key: row.id, type: 'button', title, disabled,
          'aria-pressed': !isHidden,
          onClick: () => onEdit(row.id, { enabled: isHidden }),
          style: { ...ACTION, padding: '3px 9px', borderRadius: '99px', fontSize: '11px', minHeight: '27px',
            ...(isHidden ? { opacity: .45, textDecoration: 'line-through' } : {}) },
        }, row.name)
      }))
      return h('div', { style: { display: 'grid', gap: '10px' } },
        ...families.map((family) => h('section', { key: family.key, 'aria-label': family.name + ' 模型' },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '5px' } },
            h('strong', { style: { fontSize: '12px' } }, family.name),
            h('span', { style: { fontSize: '11px' } }, String(family.rows.length))),
          chips(family.rows))),
        h('span', { style: { fontSize: '11px', lineHeight: 1.5 } },
          '点击切换显示 / 隐藏；关闭的模型不在模型选择器中列出，进行中的会话不受影响。'),
        hidden === rows.length
          ? h('p', { role: 'status', style: { margin: 0, fontSize: '11px', color: '#946200' } }, '全部隐藏后，Antigravity 将从模型选择器消失。')
          : null)
    }

    /** 账号卡片里的一行小徽标。 */
    function AccountTag({ children, color, background }) {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '1px 6px',
          borderRadius: '99px', fontSize: '11px', lineHeight: 1.6, whiteSpace: 'nowrap',
          color: color ?? 'inherit', background: background ?? TRACK,
        },
      }, children)
    }

    /**
     * 单个账号的额度块：挂载时自动读取，失败保留旧快照并标缓存。
     * 用 `readQuota.readAccount`（存在时）避免把非当前账号的额度广播给药丸。
     */
    function AccountQuota({ readQuota, source, account, model }) {
      const [data, setData] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const version = React.useRef(0)
      const pending = React.useRef(false)
      const pull = (force) => readQuota?.readAccount
        ? readQuota.readAccount(force, source, account.id)
        : readQuota?.(force, source, undefined, account.id)
      const load = async (force = true) => {
        if (!pull || pending.current) return
        pending.current = true
        const current = ++version.current
        setRefreshing(true)
        try {
          const value = await pull(force)
          if (current === version.current) setData(value)
        } catch (error) {
          if (current === version.current) {
            const message = error instanceof Error ? error.message : String(error)
            setData({ status: 'error', groups: [], error: { message } })
          }
        } finally {
          if (current === version.current) { pending.current = false; setRefreshing(false) }
        }
      }
      React.useEffect(() => {
        void load(false)
        return () => { ++version.current }
        // 账号切换 / 服务变化时重读；额度缓存由 Host 按账号隔离，打开面板不会重复打上游。
      }, [account.id, source, readQuota])
      return h('div', { style: { display: 'grid', gap: '8px', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(128,128,128,.12)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('strong', { style: { fontSize: '12px' } }, '套餐额度'),
          data?.plan ? h('span', { style: { fontSize: '12px' } }, data.plan) : null,
          h('span', { style: { flex: 1 } }),
          refreshing ? h('span', { role: 'status', style: { fontSize: '11px' } }, '读取中…') : null),
        data
          // 设置页直接铺胶囊面板的内容：分组 + 窗口百分比 + 余量条 + 重置倒计时 + Credits，
          // 不再折叠、也不再有一个可点开的弹层（对话页胶囊已是纯展示）。
          ? QuotaDetails({ data, model, showHeader: false, showCredits: true })
          : h('p', { role: 'status', style: { margin: 0, fontSize: '12px' } }, refreshing ? '正在读取…' : '尚未查询'))
    }

    /** 登录流程提示：等待时给出授权链接与取消，完成/失败只显示结果。 */
    function AccountAuthNotice({ auth, onCancel, onStart }) {
      if (!auth || auth.phase === 'idle') return null
      if (auth.phase === 'done') return h(StatusNotice, { status: { kind: 'ok', text: auth.message ?? '登录成功' } })
      if (auth.phase === 'failed') {
        return h('div', { style: { display: 'grid', gap: '6px' } },
          h(StatusNotice, { status: { kind: 'error', text: (auth.message ?? '登录失败') + '。可重新发起登录。' } }),
          onStart ? h('div', null, h('button', { type: 'button', style: ACTION, onClick: onStart }, '重新发起登录')) : null)
      }
      if (auth.phase === 'cancelled') return h(StatusNotice, { status: { kind: 'busy', text: auth.message ?? '已取消登录' } })
      const waiting = auth.phase === 'waiting'
      const href = typeof auth.authUrl === 'string' && auth.authUrl.startsWith('https://accounts.google.com/') ? auth.authUrl : undefined
      return h('div', { role: 'region', 'aria-label': '登录流程', style: { display: 'grid', gap: '8px', padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(128,128,128,.18)', background: 'rgba(23,124,85,.06)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: '12px' } }, waiting ? '等待浏览器授权' : auth.phase === 'exchanging' ? '正在完成登录' : '正在准备授权'),
          h('span', { style: { flex: 1 } }),
          onCancel ? h('button', { type: 'button', style: ACTION, onClick: onCancel }, '取消登录') : null),
        waiting && href
          ? h('a', { href, target: '_blank', rel: 'noreferrer noopener', style: { fontSize: '12px', color: '#177c55', overflowWrap: 'anywhere' } }, '浏览器没有自动打开？点此完成授权')
          : null)
    }

    /** 一个账号的卡片：身份、启停/登录/删除、额度。 */
    function AccountCard({ account, readQuota, source, model, disabled, onActivate, onRelogin, onRemove, confirmRemove, setConfirmRemove }) {
      const title = account.alias
      return h('article', { role: 'listitem', 'aria-label': '账号 ' + title, style: { padding: '11px 12px', borderRadius: '11px', border: '1px solid ' + (account.active ? 'rgba(23,124,85,.55)' : 'rgba(128,128,128,.16)'), background: account.active ? 'rgba(23,124,85,.05)' : 'rgba(128,128,128,.025)' } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '10px' } },
          h('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', flex: '0 0 auto', borderRadius: '50%', background: account.active ? '#177c55' : TRACK, color: account.active ? '#fff' : 'inherit', fontSize: '12px', fontWeight: 650 } }, title.slice(0, 1).toUpperCase()),
          h('div', { style: { minWidth: 0, flex: '1 1 260px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
              h('strong', { style: { fontSize: '12.5px' } }, title),
              account.active ? h(AccountTag, { color: '#177c55', background: 'rgba(23,124,85,.12)' }, '使用中') : null,
              !account.ready ? h(AccountTag, { color: '#b42318', background: 'rgba(180,35,24,.10)' }, '未登录') : null),
            account.email ? h('div', { style: { fontSize: '12px', marginTop: '2px', overflowWrap: 'anywhere' } }, account.email) : null),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end', marginLeft: 'auto' } },
            !account.active ? h('button', { type: 'button', disabled, style: { ...ACTION, minHeight: '28px', padding: '3px 9px', fontSize: '11px' }, onClick: () => onActivate(account) }, '使用此账号') : null,
            !account.system ? h('button', { type: 'button', disabled, style: { ...ACTION, minHeight: '28px', padding: '3px 9px', fontSize: '11px' }, onClick: () => onRelogin(account) }, account.ready ? '重新登录' : '登录') : null,
            !account.system ? h('button', {
              type: 'button',
              disabled,
              style: { ...ACTION, minHeight: '28px', padding: '3px 9px', fontSize: '11px', ...(confirmRemove ? { color: '#b42318', borderColor: 'rgba(180,35,24,.45)' } : {}) },
              onClick: () => { if (confirmRemove) onRemove(account); else setConfirmRemove(account.id) },
            }, confirmRemove ? '确认删除' : '删除') : null)),
        AccountQuota({ readQuota, source, account, model }))
    }

    function AntigravitySettingsCard(props) {
      const remote = props.remote
      const [account, setAccount] = React.useState(undefined)
      const [accountNotice, setAccountNotice] = React.useState(null)
      const [confirmRemoveId, setConfirmRemoveId] = React.useState(undefined)
      const [models, setModels] = React.useState([])
      const [modelMessage, setModelMessage] = React.useState('')
      const alive = React.useRef(true)
      const modelVersion = React.useRef(0)
      const accountVersion = React.useRef(0)
      const polling = React.useRef(false)
      const lastAuthPhase = React.useRef('idle')
      const manualModelPull = React.useRef(false)
      const pullModels = React.useCallback(async (force = false) => {
        if (!props.control || manualModelPull.current) return
        if (force) manualModelPull.current = true
        const version = ++modelVersion.current
        if (force) setModelMessage('正在拉取模型目录…')
        try {
          const value = unwrap(await props.control('models', force ? { force: true } : undefined))
          if (!alive.current || version !== modelVersion.current) return
          setModels(value.models ?? [])
          setModelMessage(value.status === 'error' ? value.message : '')
        } catch (error) { if (alive.current && version === modelVersion.current) setModelMessage(error instanceof Error ? error.message : String(error)) }
        finally {
          if (force) manualModelPull.current = false
        }
      }, [props.control])
      const accountAction = React.useCallback(async (action = 'status', request) => {
        if (!props.control) return
        if (action === 'status' && polling.current) return
        polling.current = true
        const version = ++accountVersion.current
        try {
          const value = unwrap(await props.control('account', { action, ...(request ?? {}) }))
          if (alive.current && version === accountVersion.current) {
            setAccount(value)
            if (action !== 'status') {
              const message = value?.message ?? ''
              const failed = value?.auth?.phase === 'failed' || /失败|不能|不存在|正在进行/.test(message)
              if (action !== 'add-account' && action !== 'relogin') setAccountNotice({ kind: failed ? 'error' : 'ok', text: message })
              if (action !== 'cancel-add') props.readQuota?.invalidate?.()
            }
          }
        } catch (error) {
          if (alive.current && version === accountVersion.current) {
            const message = error instanceof Error ? error.message : String(error)
            setAccount({ state: 'error', message })
            if (action !== 'status') setAccountNotice({ kind: 'error', text: message })
          }
        }
        finally { polling.current = false }
      }, [props.control, props.readQuota])
      React.useEffect(() => {
        alive.current = true
        void accountAction('status')
        void pullModels(true)
        return () => { alive.current = false; ++modelVersion.current; ++accountVersion.current }
      }, [accountAction, pullModels])
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void accountAction('status')
        }, 2000)
        return () => clearInterval(timer)
      }, [accountAction])
      React.useEffect(() => {
        if (account?.state === 'connected' || account?.runtime?.modelCatalogRevision !== undefined) void pullModels(false)
      }, [account?.state, account?.runtime?.modelCatalogRevision, pullModels])
      // 登录流程完成 / 失败时给一次提示；完成后让药丸重新读取当前账号的额度。
      React.useEffect(() => {
        const phase = account?.auth?.phase ?? 'idle'
        if (phase === lastAuthPhase.current) return
        lastAuthPhase.current = phase
        if (phase === 'done') {
          props.readQuota?.invalidate?.()
        } else if (phase === 'failed') {
          setAccountNotice({ kind: 'error', text: account?.auth?.message ?? '登录失败' })
        }
      }, [account?.auth?.phase, account?.auth?.message, props.readQuota])
      const [view, setView] = React.useState(undefined)
      const [registered, setRegistered] = React.useState(undefined)
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [writable, setWritable] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [dirtyKeys, setDirtyKeys] = React.useState([])
      const [conflicts, setConflicts] = React.useState([])
      // 设置分页。非活动页只隐藏、不卸载：草稿、保存与控件覆盖测试都依赖字段始终挂载。
      // 「账号」把连接 / 登录与套餐额度放在同一页，参考 dsh-agy-link 的账户卡片：
      // 状态、操作与额度条是同一个账户的两面，不再作为两个独立分页。
      const [settingsPage, setSettingsPage] = React.useState('account')
      const settingsVersion = React.useRef(0)
      const savingRef = React.useRef(false)
      const refreshAfterSave = React.useRef(false)
      const baseline = React.useRef({})
      const dirty = React.useRef(new Set())
      const draftRef = React.useRef(draft)
      draftRef.current = draft
      React.useEffect(() => {
        let current = true
        Promise.resolve().then(() => remote?.llm?.listProviders?.()).then(unwrap).then((providers) => {
          if (current && alive.current && Array.isArray(providers)) setRegistered(providers.some((row) => row?.id === PROVIDER))
        }).catch(() => { if (current && alive.current) setRegistered(false) })
        return () => { current = false }
      }, [remote])

      /**
       * 单条模型设置：合并成整份 modelOverrides 再交给通用编辑路径，
       * 这样草稿、冲突与只提交改动项的行为和其它字段完全一致。
       */
      const editOverride = React.useCallback((id, patch) => {
        if (savingRef.current) return
        const current = overrideFor(draftRef.current[OVERRIDES_KEY], id)
        const merged = canonicalOverride({ ...current, ...patch })
        const overrides = canonicalOverrides(draftRef.current[OVERRIDES_KEY])
        if (Object.keys(merged).length === 0) delete overrides[id]
        else overrides[id] = merged
        const value = overrides
        const next = { ...draftRef.current, [OVERRIDES_KEY]: value }
        draftRef.current = next
        if (sameOverrides(value, baseline.current[OVERRIDES_KEY])) dirty.current.delete(OVERRIDES_KEY)
        else dirty.current.add(OVERRIDES_KEY)
        setDirtyKeys([...dirty.current])
        setConflicts((previous) => previous.filter((field) => field !== OVERRIDES_KEY))
        setDraft(next)
      }, [])

      const reload = React.useCallback(async (preserveStatus = false) => {
        const version = ++settingsVersion.current
        // 同步段整体兜底：remote.<ns> 是代理属性，缺 inject 时连「读属性」都会抛；
        // 这里降级为卡片内可读错误，绝不让异常穿出组件击穿 settings.section。
        try {
          if (!remote?.settings?.describe) {
            setStatus({ kind: 'error', text: '宿主未提供 settings.describe，无法在此编辑配置' })
            setLoading(false)
            return
          }
          setLoading(true)
          const described = Promise.resolve(remote.settings.describe()).then(unwrap)
          const providers = Promise.resolve(remote.llm?.listProviders?.())
            .then((value) => unwrap(value))
            .catch(() => [])
            .then((rows) => (Array.isArray(rows) ? rows : []))
          const [settings, rows] = await Promise.all([described, providers])
          if (!alive.current || version !== settingsVersion.current) return
          const namespaces = Array.isArray(settings?.namespaces) ? settings.namespaces : []
          // 只按精确 namespace 匹配：按字段回退会命中别人的配置，而保存用的
          // revision 也必须来自同一份文档（同 profile 的 dsh-proxy 即如此）。
          const found = namespaces.find((item) => item?.ns === ENTRY_ID)
          setView(found ?? null)
          const current = found?.value && typeof found.value === 'object' ? found.value : {}
          const server = {}
          // 整份 map 作为一个字段参与脏值比较；规范化后再比，避免键序或
          // 「显式写回默认值」被误判为未保存修改。
          server[OVERRIDES_KEY] = canonicalOverrides(current[OVERRIDES_KEY])
          const changed = []
          const next = { ...server }
          for (const key of dirty.current) {
            const same = key === OVERRIDES_KEY
              ? sameOverrides(draftRef.current[key], server[key])
              : draftRef.current[key] === server[key]
            if (same) dirty.current.delete(key)
            else {
              next[key] = draftRef.current[key]
              const beforeSame = key === OVERRIDES_KEY
                ? sameOverrides(baseline.current[key], server[key])
                : baseline.current[key] === server[key]
              if (!beforeSame) changed.push(key)
            }
          }
          baseline.current = server
          draftRef.current = next
          setDraft(next)
          setDirtyKeys([...dirty.current])
          setConflicts((previous) => [...new Set([...previous.filter((key) => dirty.current.has(key)), ...changed])])
          setWritable(settings?.writable === true)
          setRegistered(rows.some((row) => row?.id === PROVIDER))
          if (!found) setStatus({ kind: 'error', text: '宿主尚未提供 Antigravity ACP 的可编辑设置。请确认 Host 与 Client 插件版本一致，并重新加载插件后刷新配置。' })
          else if (!preserveStatus) setStatus(null)
        } catch (cause) {
          if (alive.current && version === settingsVersion.current) setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          if (alive.current && version === settingsVersion.current) setLoading(false)
        }
      }, [remote])

      const save = React.useCallback(async () => {
        if (!view || !writable || loading || savingRef.current || dirty.current.size === 0) return
        savingRef.current = true
        setSaving(true)
        setStatus({ kind: 'busy', text: '保存中…' })
        // 只提交用户改动过的字段，空串也是有效改动；未编辑字段遵循最新服务端值。
        // modelOverrides 是整份 map 一个字段，按同样方式提交。
        const ops = dirty.current.has(OVERRIDES_KEY)
          ? [{ op: 'set', path: [OVERRIDES_KEY], value: draftRef.current[OVERRIDES_KEY] }]
          : []
        try {
          unwrap(await remote.settings.mutate(ENTRY_ID, ops, view.revision))
          if (!alive.current) return
          for (const operation of ops) {
            const key = operation.path[0]
            if (JSON.stringify(draftRef.current[key]) === JSON.stringify(operation.value)) dirty.current.delete(key)
          }
          setDirtyKeys([...dirty.current])
          setConflicts([])
          setStatus({ kind: 'ok', text: '已保存；进行中的会话不会被中断。' })
          await reload(true)
          void accountAction('status')
          void pullModels(true)
        } catch (cause) {
          if (!alive.current) return
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
          // 修订号冲突时同步新基线，仍保留本地草稿，供用户检查后再次保存。
          await reload(true)
        } finally {
          savingRef.current = false
          if (alive.current) {
            setSaving(false)
            if (refreshAfterSave.current) { refreshAfterSave.current = false; void reload(true) }
          }
        }
      }, [loading, writable, remote, reload, view, accountAction, pullModels, props.readQuota])

      React.useEffect(() => {
        reload()
        const off = remote?.$on?.('settings/document-updated', (ns) => {
          if (!ns || ns === ENTRY_ID) {
            if (savingRef.current) refreshAfterSave.current = true
            else void reload()
          }
        })
        return () => {
          ++settingsVersion.current
          if (typeof off === 'function') off()
        }
      }, [reload, remote])

      // 目录条目 + 已配置但目录里暂时没有的 ID：正在编辑的映射不能因为目录刷新而消失。
      const rows = modelRows(models, draft[OVERRIDES_KEY])
      const editingDisabled = loading || saving || !view || !writable
      const discardDraft = () => {
        if (savingRef.current) return
        dirty.current.clear()
        draftRef.current = { ...baseline.current }
        setDraft(draftRef.current)
        setDirtyKeys([])
        setConflicts([])
        setStatus({ kind: 'ok', text: '已撤销未保存修改。' })
      }

      const accounts = Array.isArray(account?.accounts) ? account.accounts : []
      const authBusy = ['preparing', 'waiting', 'exchanging'].includes(account?.auth?.phase)
      // CLI 开关是额度取数方式：保存前沿用已生效值，草稿不改变当前来源。
      const pageStyle = (id) => ({ display: settingsPage === id ? 'flex' : 'none', flexDirection: 'column', gap: '14px' })
      const pageButton = (id, label) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': settingsPage === id, 'aria-controls': 'agy-settings-page-' + id,
        onClick: () => setSettingsPage(id),
        style: { ...ACTION, minHeight: '32px', padding: '5px 12px', fontWeight: settingsPage === id ? 650 : 450, borderColor: settingsPage === id ? '#177c55' : 'rgba(128,128,128,.22)', background: settingsPage === id ? 'rgba(23,124,85,.12)' : 'transparent' },
      }, label)
      const readonly = !loading && view && !writable
      const saveVisible = dirtyKeys.length > 0 || loading || readonly || conflicts.length > 0 || Boolean(status)

      return h('div', { className: 'antigravity-settings-card', style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '760px', boxSizing: 'border-box', lineHeight: 1.5 } },
        h('div', { role: 'region', 'aria-label': '设置保存操作', style: { position: 'sticky', top: 0, zIndex: 20, flexShrink: 0, margin: '-6px -6px 0', padding: '6px 0', display: saveVisible ? 'grid' : 'none', gap: '6px', background: 'var(--dsh-surface, Canvas)' } },
          h('div', { style: { display: 'grid', gap: '6px', padding: '10px 12px', borderRadius: '12px', border: '1px solid rgba(128,128,128,.16)', background: 'rgba(128,128,128,.025)' } },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '7px', alignItems: 'center' } },
            h('button', { type: 'button', onClick: save, disabled: editingDisabled || dirtyKeys.length === 0, style: { ...PRIMARY, minHeight: '30px', padding: '4px 10px' } }, saving ? '保存中…' : '保存'),
            dirtyKeys.length ? h('button', { type: 'button', disabled: loading || saving, onClick: discardDraft, style: { ...ACTION, minHeight: '30px', padding: '4px 9px' } }, '撤销') : null,
            h('span', { role: 'status', 'aria-live': 'polite', style: { fontSize: '12px' } }, dirtyKeys.length ? dirtyKeys.length + ' 项未保存' : loading ? '正在读取…' : readonly ? '只读设置' : ''),
            h('button', { type: 'button', title: '重新读取配置并保留草稿', disabled: loading || saving, onClick: () => reload(), style: { ...ACTION, minHeight: '30px', padding: '4px 8px', borderColor: 'transparent', background: 'transparent', marginLeft: 'auto' } }, loading ? '刷新中…' : '刷新')),
          conflicts.length ? h('p', { role: 'alert', style: { margin: 0, fontSize: '12px', lineHeight: 1.5 } }, '以下内容已在其他位置更新，已保留你的输入：' + conflicts.map((key) => key === OVERRIDES_KEY ? OVERRIDES_LABEL : key).join('、')) : null,
          h(StatusNotice, { status }))),

        h('div', { role: 'tablist', 'aria-label': '设置分页', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
          pageButton('account', '账号'),
          pageButton('models', '模型'),
          registered === false ? h('span', { style: { marginLeft: 'auto', padding: '3px 7px', borderRadius: '99px', fontSize: '11px', color: '#b42318', background: TRACK } }, '路由未注册') : null),

        h('div', { id: 'agy-settings-page-account', role: 'tabpanel', style: pageStyle('account') },
          accountNotice && !['preparing', 'waiting', 'exchanging', 'done', 'failed', 'cancelled'].includes(account?.auth?.phase ?? '')
            ? h(StatusNotice, { status: accountNotice }) : null,
          h('section', { style: PANEL, 'aria-label': '账号' },
            h(SectionHeading, { title: '账号', description: '登录多个 Antigravity 账号；新建 ACP 连接使用「使用中」的账号。',
              action: h('button', { type: 'button', style: { ...PRIMARY, minHeight: '30px', padding: '4px 10px' }, disabled: !props.control || authBusy, onClick: () => accountAction('add-account') }, authBusy ? '等待授权…' : '添加账号') }),
            h(AccountAuthNotice, {
              auth: account?.auth,
              onCancel: authBusy ? () => accountAction('cancel-add') : undefined,
              onStart: !authBusy && account?.auth?.phase === 'failed'
                ? () => accountAction(accounts.some((row) => row.id === account?.auth?.accountId) ? 'relogin' : 'add-account',
                  accounts.some((row) => row.id === account?.auth?.accountId) ? { id: account?.auth?.accountId } : undefined)
                : undefined,
            }),
            accounts.length
              ? h('div', { role: 'list', style: { display: 'grid', gap: '8px' } },
                ...accounts.map((row) => h(AccountCard, {
                  key: row.id,
                  account: row,
                  readQuota: props.readQuota,
                  source: PROVIDER,
                  // 宿主未提供当前模型时徽标不出现；提供时按模型家族标出「当前模型」。
                  model: props.model,
                  disabled: authBusy,
                  onActivate: (target) => accountAction('activate', { id: target.id }),
                  onRelogin: (target) => accountAction('relogin', { id: target.id }),
                  onRemove: (target) => { setConfirmRemoveId(undefined); void accountAction('remove', { id: target.id }) },
                  confirmRemove: confirmRemoveId === row.id,
                  setConfirmRemove: setConfirmRemoveId,
                })))
              : h('p', { role: 'status', style: { margin: 0, fontSize: '12px', lineHeight: 1.5 } }, '正在读取账号列表…'),
            null),

          ),

        h('div', { id: 'agy-settings-page-models', role: 'tabpanel', style: pageStyle('models') },
          h('section', { style: PANEL, 'aria-label': '模型列表' },
            h(SectionHeading, { title: '模型' }),
            h(ModelChips, { rows, overrides: draft[OVERRIDES_KEY], disabled: editingDisabled, onEdit: editOverride }),
            modelMessage ? h('p', { role: 'status', style: { fontSize: '12px', lineHeight: 1.5, margin: 0, overflowWrap: 'anywhere' } }, modelMessage) : null)))
    }

    /**
     * 额度药丸：只在当前会话模型属于 antigravity-acp 时出现，位置是
     * `conversation.input.right`（宿主 InputBar 里它渲染在模型选择器之前，
     * 即「Provider 选择器左边」）。取数经 Host 的 remote.agyQuota.read。
     */
    const PILL_ID = 'antigravity-quota'

    const TRACK = 'rgba(128,128,128,.18)'
    const PANEL = { padding: '14px', borderRadius: '12px', border: '1px solid rgba(128,128,128,.16)', background: 'rgba(128,128,128,.025)' }
    const SUMMARY = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer', listStyle: 'none' }
    const ACTION = { padding: '7px 12px', minHeight: '34px', borderRadius: '8px', border: '1px solid rgba(128,128,128,.22)', background: 'rgba(128,128,128,.06)', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' }
    const PRIMARY = { ...ACTION, background: '#177c55', border: '1px solid #177c55', color: '#fff', fontWeight: 600 }
    // 2026-11-24 真机：Google 把 Gemini 4 Argon 并入 Gemini Models 额度池，HTTP / CLI 都只返回两池
    // （证据与账号口径见 docs/claims.md 第 19 条）。
    const GROUPS = [{ key: 'gemini', name: 'Gemini' }, { key: 'claude', name: 'Claude / GPT' }]
    // 旧套餐或其它账号的上游仍可能返回独立的 Gemini 4 Argon 组：只在该组确有窗口时才追加，
    // 且绝不把 Argon 的窗口并进 Gemini 池（同一组混两个来源会让百分比失去意义）。
    const LEGACY_ARGON_GROUP = { key: 'argon', name: 'Gemini 4 Argon' }
    function groupKey(name) {
      const text = String(name ?? '').toLowerCase()
      if (/\bargon\b/.test(text)) return 'argon'
      if (/\bgemini\b/.test(text)) return 'gemini'
      if (/\b(claude|gpt)\b/.test(text)) return 'claude'
      return undefined
    }
    /** 模型 ID 是否指向 Gemini 4 Argon 家族（容忍 `antigravity-` 前缀与档位后缀）。 */
    function isArgonModel(model) {
      const id = String(model ?? '').toLowerCase().replace(/^antigravity-/, '')
      return /^gemini-/.test(id) && /(?:^|-)argon(?:-|$)/.test(id)
    }
    /** Settings -> Models 的分组长：Argon 现在属于 Gemini 家族（额度也共享 Gemini 池）。 */
    function modelGroup(model) {
      const id = String(model ?? '').toLowerCase().replace(/^antigravity-/, '')
      if (/^gemini-/.test(id)) return 'gemini'
      if (/^(claude|gpt)-/.test(id)) return 'claude'
      return undefined
    }
    function quotaGroups(data) {
      const groups = Array.isArray(data?.groups) ? data.groups : []
      const result = GROUPS.map((entry) => ({ ...entry, buckets: groups.filter((g) => groupKey(g.name) === entry.key).flatMap((g) => g.buckets ?? []) }))
      // 仅当上游确实返回了带 buckets 的独立 Argon 组时才追加第三池；两池响应（含 data=null 的首载）
      // 只渲染 Gemini 与 Claude / GPT，不出现空的「Gemini 4 Argon · 未提供额度数据」。
      const argonBuckets = groups.filter((g) => groupKey(g.name) === 'argon').flatMap((g) => g.buckets ?? [])
      if (argonBuckets.length > 0) result.push({ ...LEGACY_ARGON_GROUP, buckets: argonBuckets })
      return result.concat(groups.filter((g) => !groupKey(g.name)).map((g, i) => ({ ...g, key: 'other-' + i })))
    }
    /** 当前模型的额度组：Argon 默认共享 Gemini 池，只有上游给了独立 Argon 组时才单独读取。 */
    function resolveQuotaGroupKey(model, groups) {
      if (isArgonModel(model) && groups.some((group) => group.key === 'argon' && (group.buckets?.length ?? 0) > 0)) return 'argon'
      return modelGroup(model)
    }
    function percentage(bucket) {
      return Number.isFinite(bucket?.remainingPct) ? Math.max(0, Math.min(100, bucket.remainingPct)) : undefined
    }
    function tone(bucket, stale) {
      const value = percentage(bucket)
      if (bucket?.disabled || value === undefined) return '#8b909a'
      if (value <= 10) return '#ef4444'
      if (value <= 25 || stale) return '#d99b28'
      return '#25b879'
    }
    function windowName(bucket) {
      return ({ '5h': '5 小时', weekly: '每周', '7d': '每周' })[bucket.window] ?? bucket.window ?? bucket.name ?? '额度窗口'
    }
    function resetCountdown(value) {
      const seconds = Math.ceil((Date.parse(value) - Date.now()) / 1000)
      if (!Number.isFinite(seconds)) return '未提供重置时间'
      if (seconds <= 0) return '重置时间已到，待刷新'
      const minutes = Math.ceil(seconds / 60)
      if (minutes >= 1440) return Math.floor(minutes / 1440) + '天 ' + Math.floor(minutes % 1440 / 60) + '小时后重置'
      if (minutes >= 60) return Math.floor(minutes / 60) + '小时 ' + minutes % 60 + '分钟后重置'
      return minutes + '分钟后重置'
    }
    function remainingBar(bucket, compact, stale, label, compactHeight = 4) {
      const pct = percentage(bucket)
      const unknown = pct === undefined || bucket.disabled
      return h('span', {
        role: 'progressbar', 'aria-label': label,
        'aria-valuemin': 0, 'aria-valuemax': 100,
        ...(unknown ? { 'aria-valuetext': bucket.disabled ? '已停用' : '额度未知' } : { 'aria-valuenow': pct }),
        style: { display: 'block', width: compact ? '34px' : '100%', height: compact ? compactHeight + 'px' : '4px', borderRadius: '99px', overflow: 'hidden', background: TRACK },
      }, h('span', { style: { display: 'block', height: '100%', width: unknown ? '100%' : pct + '%', opacity: unknown ? .35 : 1, borderRadius: '99px', background: tone(bucket, stale) } }))
    }
    function useQuota(readQuota, enabled = true, source, model) {
      const [data, setData] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const version = React.useRef(0)
      const currentSource = React.useRef(source)
      const currentModel = React.useRef(model)
      currentModel.current = model
      const update = React.useCallback((value) => setData(value), [])
      const load = React.useCallback((force = false) => {
        if (!enabled || !readQuota) return Promise.resolve()
        const current = ++version.current
        setRefreshing(true)
        return Promise.resolve().then(() => readQuota(force, source, model)).then(unwrap).then((value) => {
          if (current === version.current) update(value)
        }).catch((error) => {
          if (current === version.current) {
            const message = error instanceof Error ? error.message : String(error)
            setData({ status: 'error', groups: [], error: { message } })
          }
        }).finally(() => { if (current === version.current) setRefreshing(false) })
      }, [readQuota, enabled, update, source, model])
      React.useEffect(() => {
        currentSource.current = source
        setData(null)
        if (!enabled || !readQuota) { setData(null); return undefined }
        void load(false)
        const off = readQuota.subscribe?.((value, origin) => {
          if (origin !== undefined && origin !== source) return
          if (value?.requestedModel !== undefined && value.requestedModel !== currentModel.current) return
          if (value === null) {
            ++version.current; update(null); setRefreshing(false)
            void load(true)
            return
          }
          ++version.current; update(value); setRefreshing(false)
        })
        const timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load(false) }, 300_000)
        return () => { ++version.current; clearInterval(timer); off?.() }
      }, [load, enabled, readQuota, update, source, model])
      return { data: currentSource.current === source ? data : null, refreshing, load }
    }
    function CreditsDetails({ credits, pending }) {
      // 只隐藏「未开启」这一种主动关闭状态；开关已开但 CLI 缺失/不支持/上游无数据
      // 都是可排查故障，必须显示，不能静默吞掉。
      if (credits?.error?.code === 'cli-disabled') return null
      const valid = credits?.status === 'ok' && Number.isSafeInteger(credits.remainingCredits) && credits.remainingCredits >= 0
      const label = valid ? credits.remainingCredits.toLocaleString() : pending ? '正在读取…' : credits?.status === 'error' ? '查询失败' : '未提供'
      return h('section', { style: { padding: '9px 0', borderTop: '1px solid rgba(128,128,128,.16)' }, 'aria-label': 'AI Credits 余额' },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' } },
          h('strong', { style: { fontSize: '12px' } }, 'AI Credits'),
          h('strong', { style: { fontSize: valid ? '17px' : '12px', fontVariantNumeric: 'tabular-nums', color: credits?.stale ? '#d99b28' : 'inherit' } }, label)),
        credits?.stale ? h('p', { role: 'status', style: { margin: '4px 0 0', fontSize: '11px', color: '#d99b28' } }, '余额缓存 · ' + (credits.staleReason ?? '余额刷新失败')) : null,
        credits?.error?.message ? h('p', { role: credits.status === 'error' ? 'alert' : 'status', style: { margin: '4px 0 0', fontSize: '11px', overflowWrap: 'anywhere' } }, credits.error.message) : null)
    }
    function QuotaDetails({ data, model, onClose, showHeader = true, showCredits = true }) {
      const groups = quotaGroups(data)
      const activeGroupKey = resolveQuotaGroupKey(model, groups)
      return h('div', { style: { display: 'grid', gap: 0 } },
        showHeader ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', paddingBottom: '9px', borderBottom: '1px solid rgba(128,128,128,.16)' } },
          h('strong', { style: { fontSize: '14px', flex: 1 } }, 'Antigravity · 套餐额度'),
          data?.plan ? h('span', { style: { fontSize: '12px' } }, data.plan) : null,
          onClose ? h('button', { type: 'button', 'aria-label': '关闭额度详情', onClick: onClose, style: { ...ACTION, padding: '2px 7px', minHeight: '26px', borderColor: 'transparent' } }, '×') : null) : null,
        data?.stale ? h('p', { role: 'status', style: { margin: '8px 0', padding: '6px 8px', borderRadius: '7px', background: 'rgba(217,155,40,.10)', color: '#d99b28', fontSize: '11px' } }, '缓存数据 · ' + (data.staleReason ?? '刷新失败')) : null,
        data?.status === 'error' ? h('p', { role: 'alert', style: { margin: '8px 0', color: '#ef4444', fontSize: '11px', overflowWrap: 'anywhere' } }, data.error?.message ?? data.error?.text ?? '额度读取失败') : null,
        ...groups.map((group) => h('section', { key: group.key, style: { padding: '9px 0', borderBottom: '1px solid rgba(128,128,128,.14)' }, 'aria-label': group.name + '额度' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '7px' } },
            h('strong', { style: { fontSize: '12px' } }, group.name),
            group.key === activeGroupKey ? h('span', { style: { fontSize: '9px', padding: '1px 5px', borderRadius: '5px', color: '#25b879', background: 'rgba(37,184,121,.12)' } }, '当前模型') : null),
          group.buckets.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '9px 12px' } }, ...group.buckets.map((bucket, index) => {
            const pct = percentage(bucket)
            return h('div', { key: index, style: { minWidth: 0 } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', marginBottom: '4px' } },
                h('span', { style: { fontSize: '11px' } }, windowName(bucket)),
                h('strong', { style: { fontSize: bucket.disabled ? '12px' : '15px', fontVariantNumeric: 'tabular-nums' } }, bucket.disabled ? '已停用' : pct === undefined ? '未知' : Math.round(pct) + '%')),
              remainingBar(bucket, false, data?.stale, group.name + ' ' + windowName(bucket) + '剩余额度'),
              h('div', { title: bucket.disabled ? bucket.description : bucket.resetTime, style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: '11px', lineHeight: 1.35, marginTop: '4px' } }, bucket.disabled ? bucket.description ?? '此窗口不可用' : resetCountdown(bucket.resetTime)))
          })) : h('span', { style: { fontSize: '11px' } }, data ? '未提供额度数据' : '正在读取…'))),
        showCredits ? CreditsDetails({ credits: data?.credits, pending: !data }) : null)
    }
    /** 紧凑余量条与单词状态的交互参考 dsh-subusage；取数仍由本插件负责。 */
    function quotaPillStatus(data, buckets) {
      if (!data) return { short: '', icon: '…', color: '#8b909a' }
      if (data.status === 'error') return { short: '失败', icon: '!', color: '#e5534b', tint: true }
      if (data.stale) return { short: '缓存', icon: '!', color: '#d99b28', tint: true }
      const usable = buckets.filter(bucket => !bucket.disabled && percentage(bucket) !== undefined)
      if (!usable.length) return { short: buckets.some(bucket => bucket.disabled) ? '受限' : '未知', icon: '?', color: '#8b909a' }
      const minimum = Math.min(...usable.map(percentage))
      if (minimum === 0) return { short: '已用尽', color: '#e5534b', tint: true }
      if (minimum <= 10) return { short: '紧张', color: '#e5534b', tint: true }
      if (minimum <= 25) return { short: '偏少', color: '#d99b28', tint: true }
      return { short: '', color: '#25b879' }
    }
    function AgYQuotaPill({ store, readQuota }) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const isAcp = state?.current?.provider === PROVIDER
      const model = state?.current?.model
      const quota = useQuota(readQuota, isAcp, state?.current?.provider, model)
      if (!isAcp) return null
      const groups = quotaGroups(quota.data)
      // 只显示**当前所选模型所属家族**的额度。2026-11-24 起 Google 把 Gemini 4 Argon 并入
      // Gemini Models 池：Argon 默认共享 Gemini 组；仅当上游仍返回独立的、带窗口的 Argon 组时
      // 才单独读它，绝不把两池互相借用。
      const family = resolveQuotaGroupKey(quota.data?.routeModel ?? model, groups)
      const group = family === undefined ? undefined : groups.find((entry) => entry.key === family)
      const buckets = group?.buckets ?? []
      const usable = buckets.filter((bucket) => !bucket.disabled && percentage(bucket) !== undefined)
      // 多窗口时取最低的那个当家族余量，避免一个稀疏窗口把整体说成充足。
      const worst = usable.length ? Math.min(...usable.map(percentage)) : undefined
      const stale = quota.data?.stale === true
      const failed = quota.data?.status === 'error'
      const familyName = group?.name ?? (GROUPS.find((entry) => entry.key === family) ?? {}).name ?? '额度'
      const status = quotaPillStatus(quota.data, buckets)
      const value = failed ? '读取失败'
        : !quota.data ? '读取中'
        : !group ? '未知'
        : worst === undefined ? (buckets.some((bucket) => bucket.disabled) ? '已停用' : '未知')
        : Math.round(worst) + '%'
      const label = failed
        ? familyName + ' 额度读取失败' + (quota.data?.error?.message ? '：' + quota.data.error.message : '')
        : familyName + ' ' + value + (buckets.length ? ' · ' + buckets.map((bucket) => windowName(bucket) + ' ' + (bucket.disabled ? '已停用' : percentage(bucket) === undefined ? '额度未知' : Math.round(percentage(bucket)) + '% 剩余')).join(' · ') : '') + (stale ? ' · 缓存数据' : '')
      const miniBuckets = buckets.slice(0, 5)
      const miniHeight = miniBuckets.length <= 1 ? 6 : miniBuckets.length === 2 ? 5 : miniBuckets.length === 3 ? 4 : miniBuckets.length === 4 ? 3 : 2
      return h('span', { className: 'antigravity-usage-pill', role: 'status', 'aria-label': label, title: label,
        style: { display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '5px 10px', minHeight: '26px', boxSizing: 'border-box', borderRadius: '99px', border: '1px solid ' + (status.tint ? status.color + '73' : 'rgba(128,128,128,.3)'), background: status.tint ? status.color + '1a' : 'transparent', color: 'inherit', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', maxWidth: 'min(52vw, 260px)', opacity: stale ? .6 : 1 } },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, familyName),
        h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, value),
        miniBuckets.length ? h('span', { 'aria-hidden': true, style: { display: 'grid', gap: miniBuckets.length <= 2 ? '3px' : '2px' } }, ...miniBuckets.map((bucket, index) => h('span', { key: index }, remainingBar(bucket, true, stale, familyName + ' ' + windowName(bucket) + '剩余额度', miniHeight)))) : null)
    }

    /** 给 promise 加超时：Host 侧异常时界面也要落到可读错误，而不是永远 pending。 */
    function withTimeout(promise, ms, message) {
      let timer
      return Promise.race([
        Promise.resolve(promise),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        }),
      ]).finally(() => clearTimeout(timer))
    }

    /** 组装额度读取器：remote.agyQuota 由 Host 注册后才出现，短轮询等待就绪。 */
    function makeQuotaReader(scope) {
      const listeners = new Set()
      const modelsBySource = new Map()
      const read = async (force, source, model, accountId) => {
        const deadline = Date.now() + 20_000
        for (;;) {
          // **只能用 `get()`**：`scope.remote.agyQuota` 这种属性访问在未 inject 的
          // 命名空间上会由 cordis 直接抛「cannot get property "remote.<ns>" without
          // inject」，而这正是本药丸的处境（贡献型 remote 由 $mount 挂载、不进 inject）。
          // 参考实现 dsh-subusage 同样是 `ctx.get("remote.subUsage")`。
          const service = scope.get('remote.agyQuota')
          if (service && typeof service.read === 'function') {
            // Host 侧会起官方 agy CLI 取数（其启动含登录刷新）。万一它挂在网络上，
            // 也要让药丸显示「读取失败 + 原因」，而不是一直停在「额度…」。
            return await withTimeout(
              service.read({
                ...(force ? { force: true } : {}),
                ...(source === PROVIDER ? { source: 'acp' } : {}),
                ...(model ? { model } : {}),
                ...(accountId ? { accountId } : {}),
              }),
              60_000,
              '额度读取超时（Host 侧 agy CLI 60 秒内没有返回）',
            )
          }
          if (Date.now() >= deadline) {
            throw new Error('额度服务未就绪（Host 端 remote.agyQuota 未挂载）')
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      const reader = async (force, source, model, accountId) => {
        if (model) modelsBySource.set(source, model)
        const requestedModel = model ?? modelsBySource.get(source)
        const value = unwrap(await read(force, source, requestedModel, accountId))
        for (const listener of listeners) {
          if (source === undefined) listener(value)
          else listener(value, source)
        }
        return value
      }
      reader.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
      // 面板按账号取数：不广播，避免把别的账号的额度推给药丸。
      reader.readAccount = async (force, source, accountId) => {
        if (!accountId) throw new Error('缺少账号 id')
        return unwrap(await read(force, source, undefined, accountId))
      }
      // 账号切换 / 删除 / 登录完成后让药丸重新读取当前账号。
      reader.invalidate = () => { for (const listener of listeners) listener(null) }
      return reader
    }

    function makeControlReader(scope) {
      return async (method, request) => {
        if (!['account', 'models'].includes(method)) throw new Error('不支持的设置操作')
        const deadline = Date.now() + 20_000
        for (;;) {
          const service = scope.get('remote.agyQuota')
          if (typeof service?.[method] === 'function') {
            const pending = service[method](request)
            // 目录发现可能包含冷启动；各阶段超时由 Host 管理，客户端不另设更短的总期限。
            return method === 'models' ? await pending : await withTimeout(pending, 60_000, '设置操作超时，请重试')
          }
          if (Date.now() >= deadline) throw new Error('设置控制服务未就绪，请确认 Host 与 Client 版本一致')
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }


    /**
     * 客户端侧的额度 remote 声明。
     *
     * **贡献型 remote 必须在客户端显式挂载一次**（`ctx.remote.$mount(...)`），
     * `remote.agyQuota` 才会成为客户端可查的服务——同宿主上正常工作的
     * `dsh-subusage` 就是这么写的（`ctx.remote.$mount(subUsageRemote)` 之后再
     * `ctx.get("remote.subUsage")`）。只做 Host 侧注册而不挂载，客户端永远查不到服务。
     *
     * 声明必须与 Host 侧 `AGY_QUOTA_INVOCATIONS` 逐字段一致：id / service / namespace /
     * method / 参数与结果的 codec（客户端要按同一 codec 编解码）。
     */
    const AGY_QUOTA_PACKAGE = 'dsh-bundle-antigravity-acp'
    const AGY_QUOTA_SERVICE = 'agyQuota'

    function strictCodec(typeSymbol, parse) {
      const schema = { parse }
      return { mode: 'strict', typeSymbol, create: () => schema }
    }

    function parseQuotaRequest(value) {
      if (value === undefined || value === null) return undefined
      if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaRequest')
      if (value.force !== undefined && typeof value.force !== 'boolean') throw new TypeError('Invalid AgYQuotaRequest.force')
      if (value.source !== undefined && value.source !== 'acp') throw new TypeError('Invalid AgYQuotaRequest.source')
      if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) throw new TypeError('Invalid AgYQuotaRequest.model')
      if (value.accountId !== undefined && (typeof value.accountId !== 'string' || !value.accountId.trim())) throw new TypeError('Invalid AgYQuotaRequest.accountId')
      return value
    }

    function parseQuotaResult(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaResult')
      if (value.status !== 'ok' && value.status !== 'error') throw new TypeError('Invalid AgYQuotaResult.status')
      if (!Array.isArray(value.groups)) throw new TypeError('Invalid AgYQuotaResult.groups')
      return value
    }

    const AGY_QUOTA_REMOTE = {
      package: AGY_QUOTA_PACKAGE,
      descriptors: [
        {
          id: `${AGY_QUOTA_PACKAGE}#${AGY_QUOTA_SERVICE}/read`,
          service: AGY_QUOTA_SERVICE,
          namespace: AGY_QUOTA_SERVICE,
          method: 'read',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'request',
              wire: 'request',
              source: 'json',
              acceptsUndefined: true,
              codec: strictCodec(`${AGY_QUOTA_PACKAGE}#AgYQuotaRequest`, parseQuotaRequest),
            },
          ],
          result: strictCodec(`${AGY_QUOTA_PACKAGE}#AgYQuotaResult`, parseQuotaResult),
        },
        ...['account', 'models'].map((method) => ({
          id: `${AGY_QUOTA_PACKAGE}#${AGY_QUOTA_SERVICE}/${method}`, service: AGY_QUOTA_SERVICE, namespace: AGY_QUOTA_SERVICE, method,
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true,
            codec: method === 'models' ? strictCodec(`${AGY_QUOTA_PACKAGE}#AgYQuotaRequest`, parseQuotaRequest)
              : strictCodec(`${AGY_QUOTA_PACKAGE}#AgYAccountRequest`, (value) => {
                if (value === undefined) return { action: 'status' }
                if (!value || typeof value !== 'object') throw new TypeError('Invalid AgYAccountRequest')
                if (!['status', 'login', 'warmup', 'cancel'].includes(value.action)
                  && !['add-account', 'cancel-add', 'activate', 'remove', 'relogin'].includes(value.action)) throw new TypeError('Invalid AgYAccountRequest')
                if (value.id !== undefined && (typeof value.id !== 'string' || !value.id.trim())) throw new TypeError('Invalid AgYAccountRequest.id')
                if (value.alias !== undefined && typeof value.alias !== 'string') throw new TypeError('Invalid AgYAccountRequest.alias')
                return value
              }) }],
          result: strictCodec(`${AGY_QUOTA_PACKAGE}#${method === 'models' ? 'AgYModelsResult' : 'AgYAccountResult'}`, (value) => {
            if (!value || typeof value !== 'object') throw new TypeError('Invalid settings result')
            if (method === 'models' ? !Array.isArray(value.models) || !['ok', 'error'].includes(value.status)
              : !['idle', 'connecting', 'cancelling', 'connected', 'cancelled', 'error'].includes(value.state) || typeof value.message !== 'string') throw new TypeError('Invalid settings result')
            return value
          }),
        })),
      ],
    }

    return {
      name: 'dsh-bundle-antigravity-acp',
      // remote.settings / remote.llm 必须逐个声明：remote 各命名空间是独立服务，
      // 漏声明会在读取属性时抛「without inject」并击穿 settings.section 卡片。
      inject: ['slots', 'remote', 'remote.settings', 'remote.llm'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined' || !document.head || !document.createElement) return () => {}
          const style = document.createElement('style')
          style.textContent = '.antigravity-usage-pill>button:hover{filter:brightness(1.08)}.antigravity-usage-pill button:focus-visible,.antigravity-settings-card button:focus-visible,.antigravity-settings-card a:focus-visible{outline:2px solid #4a90e2;outline-offset:3px}.antigravity-settings-card button:disabled{cursor:not-allowed;opacity:.55}'
          document.head.appendChild(style)
          return () => style.remove()
        }, 'antigravity: scoped control styles')
        const readQuota = makeQuotaReader(ctx)
        const control = makeControlReader(ctx)
        // 挂载本包贡献的 remote（幂等，随 fiber 一起 dispose）。挂载失败不影响其它卡片：
        // 药丸会自行超时并显示「额度服务未就绪」的原因。
        try {
          const mounted = ctx.remote.$mount({
            package: AGY_QUOTA_PACKAGE,
            descriptors: [...AGY_QUOTA_REMOTE.descriptors],
          })
          ctx.effect(() => mounted, 'antigravity-acp: mount quota remote')
        } catch (error) {
          console.error('[dsh-bundle-antigravity-acp] 额度 remote 客户端挂载失败:', error)
        }
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'antigravity-acp',
                  order: 42,
                  label: () => 'Antigravity ACP',
                  inject: () => ({ remote: ctx.remote, control, readQuota }),
                },
                AntigravitySettingsCard,
              ),
            ),
          'antigravity-acp: settings section',
        )
        // 额度药丸：紧邻模型选择器左侧（宿主把 conversation.input.right 渲染在
        // conversation.input.model 之前）。modelDirectories 是会话模型目录服务。
        //
        // 注意：这里**不能**把 `remote.agyQuota` 写进 inject。贡献型 remote 的客户端
        // 服务要等 `ctx.remote.$mount(...)`（见 apply 里那段）完成后才存在，写进 inject
        // 会让整个注册回调一直等待 —— 表现为**药丸彻底消失**（2026-10-17 实测踩过）。
        // 正确做法是照常注册 slot，由读取器短轮询等服务出现。
        ctx.inject(['slots', 'modelDirectories'], (scope) => {
          // 读取器按 scope 建一次：药丸的取数 effect 依赖 readQuota 的身份，若每次
          // inject 都新建函数，身份变化会让 effect 反复重跑、重复触发 Host 侧 CLI 取数。
          scope.effect(
            () =>
              scope.slots.inject('conversation.input.right', () =>
                scope.slots.register(
                  {
                    name: 'conversation.input.right',
                    id: PILL_ID,
                    order: 1002,
                    inject: (sessionId) => ({
                      store: scope.modelDirectories.directoryFor(sessionId).store,
                      readQuota,
                    }),
                  },
                  AgYQuotaPill,
                ),
              ),
            'antigravity-acp: quota pill',
          )
        })
      },
    }
  },
})
