/** 离线预览夹具共享模块：从真实 client 组件生成模拟数据的静态 HTML；无登录/联网/宿主访问。 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const source = readFileSync(new URL("../src/client.js", import.meta.url), 'utf8')
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString()
const quota = { status: 'ok', updatedAt: '2026-10-22T03:00:00+08:00', plan: '示例套餐', groups: [
  { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 86, resetTime: inMinutes(2 * 60 + 23) }, { window: 'weekly', remainingPct: 72, resetTime: inMinutes(6 * 1440 + 180) }] },
  { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 42, resetTime: inMinutes(4 * 60 + 51) }, { window: 'weekly', remainingPct: 24, resetTime: inMinutes(3 * 1440 + 300) }] },
], credits: { status: 'ok', remainingCredits: 1234, planName: '示例套餐', updatedAt: '2026-10-22T03:00:00+08:00' } }
/** 第二张账号卡片用另一组数字：预览里能区分「主账号 / 备用账号」，不是把同一份数据贴两遍。 */
const quotaBackup = { status: 'ok', updatedAt: '2026-10-22T02:40:00+08:00', plan: '示例套餐', groups: [
  { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 65, resetTime: inMinutes(1 * 60 + 12) }, { window: 'weekly', remainingPct: 50, resetTime: inMinutes(5 * 1440 + 60) }] },
  { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 90, resetTime: inMinutes(3 * 60 + 34) }, { window: 'weekly', remainingPct: 80, resetTime: inMinutes(2 * 1440 + 90) }] },
], credits: { status: 'ok', remainingCredits: 568, planName: '示例套餐', updatedAt: '2026-10-22T02:40:00+08:00' } }
let plugin
runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value } } } })
let index = 0
let states = {}
const React = {
  createElement: (type, props, ...children) => typeof type === 'function' ? type({ ...(props ?? {}), children: children.flat() }) : ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [index in states ? states[index++] : (index++, initial), () => {}],
  useRef: (value) => ({ current: value }), useCallback: (fn) => fn, useEffect() {}, useId: () => 'preview',
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const components = new Map()
const ctx = {
  effect(fn) { fn(); return () => {} }, inject(_deps, fn) { fn(ctx) }, get() {},
  remote: { $mount() { return () => {} } },
  slots: { inject(_name, fn) { fn(); return () => {} }, register(row, component) { components.set(row.id, component); return () => {} } },
}
plugin.factory(() => React).apply(ctx)
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const booleanAttributes = new Set(['disabled', 'checked', 'selected', 'multiple', 'readOnly', 'required'])
const unitlessStyles = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order'])
function html(node) {
  if (node === undefined || node === null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return escape(node)
  const { type, props, children } = node
  let attrs = ''
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || key === 'ref' || key === 'key' || key.startsWith('on')) continue
    if (key === 'style') {
      attrs += ' style="' + escape(Object.entries(value).map(([k, v]) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ':' + (typeof v === 'number' && v !== 0 && !unitlessStyles.has(k) ? v + 'px' : v)).join(';')) + '"'
    } else if (booleanAttributes.has(key)) { if (value) attrs += ' ' + key.toLowerCase(); }
    else attrs += ' ' + key + '="' + escape(value) + '"'
  }
  const content = type === 'select' ? children.map((child) => child?.type === 'option' && child.props.value === props.value ? { ...child, props: { ...child.props, selected: true } } : child) : children
  return '<' + type + attrs + '>' + content.map(html).join('') + '</' + type + '>'
}
function render(id, values, props) { index = 0; states = values; return html(components.get(id)(props)) }
/** 对话页药丸是纯展示、不可点开；`open` 只是保留给 render-readme-assets / preview-ui 的兼容参数。 */
function pill(model, open = false) {
  void open
  return render('antigravity-quota', { 0: quota },
    { store: { subscribe() {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model } }) } })
}
const models = [{ id: 'gemini-3.8-flash', name: 'Gemini Flash', inputModalities: ['text', 'image'] }, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet', inputModalities: ['text'] }, { id: 'gemini-4-argon', name: 'Gemini 4 Argon', inputModalities: ['text', 'image'] }]
const settings = render('antigravity-acp', {
  0: { state: 'connected', message: 'ACP 已预热，连接将保留供聊天复用（模拟）', runtime: {
    phase: 'ready', phaseElapsedMs: 800, processRunning: true, uptimeMs: 183400,
    starts: 1, reuses: 4, recycles: 0,
    queue: { active: 0, parked: 0, waiting: 0, workers: 1, capacity: 2 },
    startup: { elapsedMs: 7120, timings: { binary: 20, credentials: 2100, spawn: 10, initialize: 4990 } },
    round: { model: 'gemini-3.8-flash-low', elapsedMs: 4800, timings: { connection: 1, session: 1200, model: 10 }, firstChunkMs: 1800, firstToolMs: 2100, continuations: 2, lastContinuationMs: 1200 },
  }, accounts: [{ id: 'primary', alias: '主账号（系统登录）', system: true, active: true, ready: true, createdAt: 0 }, { id: 'acc_demo', alias: '备用账号', email: 'backup@example.com', system: false, active: false, ready: true, createdAt: 1 }], activeAccountId: 'primary', auth: { phase: 'idle' } },
  3: models,
  // 索引必须与 src/client.js 的 useState 调用顺序一一对应（useRef / useCallback / useEffect 不占位）：
  // 5 view / 6 registered / 7 draft / 8 status / 9 loading / 10 writable / 11 saving /
  // 12 dirtyKeys / 13 conflicts / 14 settingsPage / 15–16 主账号 AccountQuota(data / refreshing) /
  // 17–18 备用账号 AccountQuota(data / refreshing)。client.js 增删 useState 时必须同步这里。
  5: { revision: 1 }, 6: true,
  7: { proxyUrl: '', agyCliPath: '', cliQuotaEnabled: false, modelOverrides: { 'gemini-4-argon': { target: 'gemini-4-argon-high' }, 'claude-sonnet-5-5': { name: 'Claude Sonnet（长上下文）' } } },
  8: null, 9: false, 10: true, 11: false, 12: [], 13: [],
  // 账号页：两张账号卡片各自铺开自己的额度（默认停在账号页，与真实面板一致）。
  14: 'account', 15: quota, 16: false, 17: quotaBackup, 18: false,
}, { remote: {}, control() {}, readQuota() {} })
export { quota, models, settings, pill, render, escape }
