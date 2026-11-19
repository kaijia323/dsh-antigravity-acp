# 开发、验证与发布

[返回主页](../README.md) · [使用参考](reference.md) · [配置](configuration.md) · [更新记录](changelog.md)

## 项目结构

本包是独立的 DSH Host + Web Client bundle，不修改宿主 Core。

| 入口 / 目录 | 职责 |
|---|---|
| [`src/index.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/index.ts) | Cordis apply / dispose、provider 注册、受管进程与可选附件服务 |
| [`src/pool/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/pool/) | 独立 worker 容量、排队、所有权与取消 |
| [`src/adapter/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/adapter/) | 模型发现、历史信封、图片、工具参数与 prompt 续轮 |
| [`src/protocol/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/protocol/) | ACP stdio、请求期限、版本 / 能力验证 |
| [`src/bridge/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/bridge/) | 私有 loopback MCP、工具目录、挂起调用与结果回填 |
| [`src/runtime/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/runtime/) | 官方程序、运行目录、登录材料、代理、CLI 与模型缓存 |
| [`src/quota/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/quota/) | 套餐 / Credits 快照、连接控制与 Typert remote |
| [`src/client.js`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/client.js) | 惰性 CommonJS 客户端、设置卡片与额度药丸；无 Node 原生导入 |
| [`src/settings.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/settings.ts) | 完整 Config 与默认值 |
| [`cordis.patch.yml`](../cordis.patch.yml) | 仅插入本插件，不抢占默认模型 |
| [`tests/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/tests/) | 假 ACP / MCP、隔离 runtime、真实 React renderer 与回归测试 |

npm 包名为 `dsh-bundle-antigravity-acp`，provider ID 为 `antigravity-acp`，内部插件名为 `llm-antigravity-acp`，三者不混用。工具执行权仍在 DSH；ACP `tool_call` 通知不是本机执行指令。

## 依赖与契约基准

以 [`package.json`](../package.json) 与 [`package-lock.json`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/package-lock.json) 为准：

| 依赖 / 协议 | 当前基准 | 核验边界 |
|---|---|---|
| DSH `dsh-llm` / `dsh-subprocess` / `dsh-typert-protocol` | 开发依赖 `0.2.1-alpha.4` | 本地类型、调用链与测试；不是全部 peer 范围实机认证 |
| 可选 `dsh-attachment` | 开发依赖 `0.2.1-alpha.4` | Host 服务在场时读取图片，缺少时文本降级 |
| Cordis | 开发依赖 `4.0.5-alpha.2` | 生命周期与注入契约 |
| ACP SDK / wire protocol | SDK `1.4.0` / wire **v1** | 两者不是同一版本；v2 / RFD 草案不能替代 v1 |
| 默认官方 ACP server | `1.4.0` | 与 SDK 分别设置；厂商 `_meta.antigravity` 扩展不自动适用于任意上游版本 |
| MCP SDK | `1.32.1` | loopback 工具桥与结果内容 |
| `@cortexkit/antigravity-auth-core` | `3.0.14`（生产依赖） | OAuth 常量、agy 线头与额度 HTTP 请求所需的公共定义 |
| undici | `8.11.2` | 本包直接依赖，HTTP / SOCKS 代理；SOCKS5 可能输出实验性 API 警告 |
| React / test renderer | `18.3.1` | Client 使用宿主 React；renderer 是测试开发依赖，不是生产私带的 UI 运行时 |

三个 `dsh-*` peer 当前均声明 `>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-0 <0.3.0-0`，Cordis peer 为 `~4.0.4 || 4.0.5-alpha.1 || 4.0.5-alpha.2`。宽范围只表达安装条件，不能推导全部版本通过运行验证。CLI、Desktop 壳与实际 Core 的版本应分别核对。

## 构建与本地打包

需要 Node.js `>=22.19`。先检查依赖和脚本，在开发工作副本准备依赖：

```console
npm ci --ignore-scripts
npm run check
npm pack --dry-run
npm pack
```

`check` 顺序执行 `typecheck`、`test`、`build`：构建由 TypeScript 输出 `dist/`，再通过 [`scripts/copy-client.mjs`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/scripts/copy-client.mjs) 复制客户端文件。`dist/` 不提交到 Git，但发布包必须包含它。

**本包没有自动构建的 prepare / prepack / install hook**，所以裸 `npm pack` 或 `npm publish` 不会替你构建。打包前必须先运行构建 / 完整检查。发布清单包含 `dist/`、patch、README、`docs/`、LICENSE；源码、测试、预览与本地审查记录不属于安装包。

检查 tarball 的包名 / 版本、导出入口、客户端、patch 和文档后，再通过目标 DSH 插件管理入口安装。工作区构建、包内容检查、Profile 安装、启用与真实调用分别验证。

## 本次验证矩阵

0.1.35 本地检查日期：**2026-11-03**；0.1.36（额度取数解耦、设置页紧凑布局与隔离修复）复检日期：**2026-11-04**（Asia/Hong_Kong）；0.1.37（AI Credits 未开启时隐藏、删除代理积分说明、保存栏面板化样式）复检日期：**2026-11-04**（Asia/Hong_Kong）；0.1.38（无档位模型的元数据、模式总线回切、设置卡片只编辑即时字段、会话选模按会话判定、一次性请求不再占死 worker、账户刷新与资源回收修复）复检日期：**2026-11-12**（Asia/Hong_Kong）；0.1.39（设置页合并账号页、多账号与面板 OAuth、紧凑额度摘要）复检日期：**2026-11-17**（Asia/Hong_Kong）；0.1.40（额度失败原因直接显示，agy 登录失效/代理不可达给出可行动提示）复检日期：**2026-11-17**（Asia/Hong_Kong）。

0.3.2-fork.1（kaijia323，2026-11-19）复检：`npm run check` 通过（typecheck + 410+ 单测 + build）；真机 E2E 在 DSH 0.2.2-rc.5 + 本机 Gemini 账号完成——工具执行中 steer 的回合正常完成并回复 `6 × 7 = 42`，默认路由 Gemini 子代理成功返回 `OK`（无 `session/new` 超时）。证据会话：`session-a25898d0` / 子会话 `b5efdd10`。

| 验证项 | 状态与范围 |
|---|---|
| TypeScript | `npm run typecheck` 通过 |
| 隔离回归 | 38 个文件 / 688 项通过；本次使用系统 Node 26.13.0 运行同一 TypeScript / Vitest / 构建入口 |
| 构建 | `npm run build` 通过 |
| 工具 / runtime | 假 ACP / MCP、乱序工具结果、池所有权、续轮变更、取消、写入阻塞和回收 |
| 图片 | 附件引用校验、图片内容映射与跨 worker 能力、附件缺席降级；未调用真实视觉模型 |
| 设置交互 | React 18 renderer 覆盖全部即时字段（普通配置不在卡片内编辑，`proxyBypass` 不提供控制项）与逐模型 `modelOverrides` 的显示开关、保存回读、草稿、冲突、只读与 namespace 恢复；账号 / 模型分页后非活动页只隐藏不卸载，账号页渲染账号卡片、添加账号的授权链接与取消、切换、两段确认删除与逐账号额度；不替代真实宿主设置服务或 GUI 验收 |
| 多账号 | 账号持久化 / 坏文件回退 / 跨目录记录拒绝；系统账号不可删除、不可面板重登；真实 loopback OAuth 回调（state 不匹配不消费流程）、取消清理暂存目录、换码失败与登录后自动激活；隔离 HOME 的 Linux D-Bus / Windows USERPROFILE / Unix HOME 覆盖；ACP 启动按账号 id 与登录代际回收旧链路；额度缓存与在途请求按账号隔离；不触真实 Google 账户 |
| 面板 OAuth | PKCE / authorize URL 参数、授权码换 token、userinfo 邮箱、CLI token 文件形态与 0600、ACP 凭据文件直写；授权 URL 只含 state / challenge，不下发 code 或 token；测试使用 127.0.0.1 与假 fetch，不代表真实 Google 可达性 |
| 无 CLI 授权闭环 | 不存在的 CLI 文件 → 实际 OAuth/PKCE → 生产监听器随机测试端口的真实 HTTP 回调 → 模拟 Google 换码/项目 → 真实临时 store → 真实适配器目录 → 重建读取；拒绝/缺码/过期/端口冲突/项目及保存失败/取消后可重试 |
| 设置页 UX | 精简首屏、无修改时隐藏保存区、当前账户、模型显示标签、账号卡片与自动额度；未保存计数/撤销/只读/冲突，取消可用性、授权链接/阶段；自动额度、实际路由家族、账户切换及旧广播、共享刷新收尾 |
| 浏览器布局 | 已注册 Chrome + 既有 Playwright 1.63.0，离线真实 Client 静态夹具；320/390/1280 宽度、深浅主题及顶部/中部/底部共 36 项检查，保存栏可见且无横向溢出；静态布局不替代桌面实例验收 |
| 桌面注册契约 | 核对当前桌面分发包内 Core 0.2.1-rc.5 / Cordis 4.0.5 的 Typert 注册实现；使用该包实际依赖隔离导入构建产物，真实 Context 中只出现一个 package-face，provider 注册生效，卸载后路由和 ready 状态清理。未连接当前运行中的 Host 或真实账户 |
| 代理（出网） | 合成依赖、动态变更与清空、不打断旧响应、卸载释放、失败不直连、运行期地址变坏时按 Promise 拒绝、装载期非法地址不阻断插件、本地 SOCKS 测试；不是 Google 网络可达性保证 |
| 代理环境继承 | HTTPS / ALL / HTTP 优先级、显式值覆盖及清空恢复、OAuth 与原生 TLS 接线、本地 CONNECT 首包和 NO_PROXY。无凭据 Google 探针对比直连超时与环境代理收到 401，只验证工具进程所见网络，不代表运行中 Host 的环境或账户可用性 |
| 系统代理检测 | 环境变量优先级、Windows 注册表 `ProxyEnable` / `ProxyServer`、macOS `scutil --proxy`、Linux GNOME manual / none、非法地址忽略；`run` 全部注入假实现，不触真实系统设置 |
| 额度取数 | 假 fetch 覆盖超时折叠、401/403 按状态码重试一次、401 后成功、非 401/403 不重试、OAuth 元数据配对；`cliQuotaEnabled` 默认关闭时即使注入 CLI 也不 spawn，打开后才走 `/usage` 与 `/credits`，关闭后旧快照失效；不触真实账户 |
| 真实上游 / GUI | 本次 OAuth 使用真实本地 HTTP 与模拟 Google 响应，浏览器使用离线夹具；0.1.40 安装后的 GUI、真实 Google 授权、真实生成或图片识别尚未验收 |
| 非 Windows | 有平台映射与契约测试，未实机验收 |
| 生产依赖漏洞 | `check` 不包含漏洞审计；没有单独成功审计证据就不声明通过 |

历史 CLI 真实账号记录见[额度来源](reference.md#登录态与额度来源)。那些记录不是本次重新执行，也不能代替当前 npm 包安装后的验收。

### 离线界面预览

```console
node scripts/preview-ui.mjs
```

输出 `.local-preview/quota-ui.html`，以及有独立滚动容器的 `.local-preview/settings-ux.html`。覆盖额度药丸、账号页（账号卡片 + 逐账号自动额度 + 连接操作）、模型显示标签页、常驻保存栏与自动额度；使用真实 Client 和**模拟数据 / hooks**生成静态 HTML，按钮不执行真实操作。状态交互由 `tests/client-interaction.test.ts` 的 React 18 renderer 覆盖，布局另由离线浏览器核验。

### 本次改动的补充验证

2026-11-19 的「删除剩余的名字猜测」通过 `npm run check`：类型检查、**35 个文件 / 407 项测试**与构建；真机 `AGY_REAL_ACP=1` 回归通过（日志确认 `模型路由 … configId=model` / `档位路由 … configId=thought_level`，续轮与复用正常）。

**真机证据**：`session/new` 返回 3 个 config option，全部带 `category`——
`{id:"model", category:"model"}`、`{id:"thought_level", category:"thought_level"}`、
`{id:"mode", category:"mode"}`；档位当前为 `low/medium/high/xhigh` 四档。

**判断依据**：不是所有启发式都要删。判据是「猜错时的代价」——
- 脱敏正则猜不到 → 少脱敏，可容忍（保留白名单做法）；
- 模型目录名字匹配猜错 → 把别的 select 当模型选择器，**路由错误不可逆**（删除）；
- 档位后缀写死 → 新档位被显示成独立模型，污染选择器（改为数据驱动）；
- 续轮判定猜错 → 整轮 `AGY_SESSION_UNRECOVERABLE`，对话报废（0.3.0 已改 id）。

只有落在「失败不可逆」分支上的猜测才必须消除；其余保留并注明取舍。

2026-11-19 的「删除注入判定，改用 message id」通过 `npm run check`：类型检查、**33 个文件 / 397 项测试**与构建；真机 `AGY_REAL_ACP=1` 的两组实验全部通过。

**证据（真机 + 真实历史）**：

- `tests/real-id-stability.test.ts`：扫描 1125 条真实 message、14 种 `source.kind`，确认每条都有 `id`、UUID 形态、**单个会话内全部唯一**（60 个会话逐一检查）。曾误判为「跨会话有重复 id」，实为跨会话不共享 id 空间的正常现象。
- `tests/real-injection-regression.test.ts`：工具循环中途注入，续轮正常。
- `tests/real-restart-resume.test.ts`：销毁 adapter 后新建实例 + 同一 `sessions.json` 恢复成功（`已恢复 ACP 会话 … 已发送消息=1`，`finish=stop`）。**这是 id 纳入指纹后最危险的路径**，必须真机验证——离线用例无法覆盖跨进程。

**一次被实验否定的中途修改**：第一次跑恢复实验失败，报「历史不是已发送前缀的追加」。排查后确认不是 DSH 的问题，而是实验脚本重建历史时**新造了消息对象**（新 id），与 DSH「从日志原样返回同一条消息」的真实行为不符。修正脚本后通过。这条记录保留，因为「同 id 才算同一条消息」正是本次改动的核心前提。

**为什么删掉判定逻辑**：连续三版（0.2.2/0.2.3/0.2.4）都在补同一个集合，根因是指纹不含身份。现在依赖 DSH 的稳定 id 契约，不再枚举来源类型。

2026-11-19 的「注入判定按来源而非 form 白名单」通过 `npm run check`：类型检查、**33 个文件 / 409 项测试**与构建；真机 `AGY_REAL_ACP=1` 两例通过。新增 15 例覆盖真实出现过的全部 `source` 形状（含 `notice`、无 form 的 `goal`/`schedule`/`working-directory`），以及「`tool-jobs` 位于尾部时续轮仍成立」。

教训：0.2.2 与 0.2.3 连续两次都是「枚举了不完整的集合」。0.2.2 只改比较侧没改构造侧；0.2.3 把 `form` 当成有限枚举。两次都靠真机反馈才发现，离线用例当时的覆盖面没有包含这些形状。现在判定改为「默认注入、按来源排除」，新增来源类型不需要再改代码。

2026-11-19 的「注入块剔除两侧对称」通过 `npm run check`：类型检查、**33 个文件 / 395 项测试**与构建。真机证据（`AGY_REAL_ACP=1`，`gemini-4-hydrogen` + 官方 `agy acp`）：`real-injection-regression` 两例通过；离线新增两例锁定对称性（构造时历史含注入块仍可续轮、注入块之外的真实内容变化仍被拒绝）。

问题来源：0.2.2 只改了 `ContinuationState.accepts()` 一侧。`#history` 在构造时用 `messages.map` 原样保留注入块，而 `accepts()` 比对的 `prefix` 已剔除它们，两个序列长度不等导致索引错位。真机表现为「首轮 step 1 正常、step 2 立即 `AGY_SESSION_UNRECOVERABLE（没有可用的会话映射）`」——因为续轮永远不会被接受，`#abandonTurn()` 随即丢弃会话与映射。该缺陷在 0.2.2 的离线用例下不可见：那些用例的 `GenerateOptions.messages` 里都没有注入块，构造侧与比较侧的差异因此无法暴露。

2026-11-18 的「工具循环中途注入不再让整轮失败」通过 `npm run check`：类型检查、**33 个文件 / 393 项测试**与构建。**真实上游证据**（`AGY_REAL_ACP=1 npx vitest run tests/real-injection-regression.test.ts`，模型 `gemini-4-hydrogen`，官方 `agy acp` 真进程、真 adapter、真 MCP 桥）：

- 修复前：第 2 轮在工具结果之后追加一条 `time-context` 形状的注入块 → `trailingToolResults()` 返回空 → `matchesParkedCalls()` 首行 false → `#abandonTurn()` 丢弃会话与会话映射 → 整轮 `AGY_SESSION_UNRECOVERABLE`（无法接上原 ACP 会话（没有可用的会话映射））。日志顺序为「取消后保留 ACP 会话」→「放弃 ACP 会话复用（MCP 桥已被其他对话接管）」。
- 修复后：同一场景 `finish={"kind":"stop"}`，日志保留「复用 ACP 会话 … 本轮新增=2」，不再出现「放弃 ACP 会话复用」；对照组（尾部为纯工具结果）行为不变。
- 离线锁：`tests/continuation-state.test.ts` 新增 4 例覆盖「尾部注入仍可续轮」「中间注入不破坏前缀」「真实用户消息仍破坏前缀」「篡改交付块仍被拒」。

该复现同时纠正了两条此前的推测：一是 `resetPending()` 并**不**清空桥的 owner（`invalidateRound()` 才清空并轮换 token），二是「把 `bridge.owner` 空值也当作被接管」的改法**不能**采纳——工具会话的 MCP 连接握的是旧 token，放行会得到一条工具已死的会话。本次修复只发生在续轮判定层，桥的归属守卫保持原样。

2026-11-17 的「模型选择页只列模型」通过 `npm run check`：类型检查、**39 个文件 / 682 项测试**与构建。适配器不再声明 `reasoning`（宿主据此渲染档位控件），相关断言改为「`resolveModel` 在有无 `thought_level` 观测时都返回 `reasoning: undefined`」；档位观测、落盘（`catalog.json` v2）与写入路径仍有测试覆盖：显式传 `reasoningEffort` 时写入 `thought_level`、未声明档位就收敛（`xhigh` → `high`）、切到 Hydrogen 后按新选项发 `xhigh`、缓存恢复后仍能写入。未在运行中的 GUI 上重验「菜单里不再出现档位」以及旧会话重新选模后的发送，发布前仍需实机确认。


2026-11-17 的「思考强度回归模型元数据」通过 `npm run check`：类型检查、**39 个文件 / 683 项测试**与构建。**真实上游证据**：本机 `/root/.local/bin/agy acp`（Antigravity ACP Server 1.5.10）跑 `initialize` → `session/new` → `session/set_config_option`（不发 prompt）确认：`model` 选择器的选项已是家族 id（`gemini-4-argon`、`claude-opus-5-5`…），思考强度是独立的 `thought_level` 选择器（`low/medium/high`，切到 `gemini-4-hydrogen` 后多出 `xhigh`/Extra），发 `model=claude-opus-5-5-high` 会被 agent 拆成 `model=claude-opus-5-5` + `thought_level=high`，发家族 id 则保留 `thought_level`。据此重写适配器并新增覆盖：`findThoughtLevelSelector`（category / 启发式 / 分组选项）、元数据取 agent 的 `thought_level` 选项与标签、`xhigh` 不再被三档白名单截断、模型只发家族 id + 档位单独写、未声明档位就近收敛（`xhigh` → `high`）、切到 Hydrogen 后按新选项发 `xhigh`、档位随目录落盘并按 `catalog.json` v2 读回、跨 worker 共享档位选择器。该轮**未**在运行中的 GUI 上重验真实聊天与档位落库，发布前的实机确认仍待补。

2026-11-17 的「账号」页合并与多账号通过 `npm run check`：类型检查、**38 个文件 / 688 项测试**与构建。新增覆盖账号页默认选中且只剩「账号 / 模型」两个分页、连接操作与逐账号自动额度同页可用、添加账号的授权链接 / 取消 / 完成后自动切换、切换与两段确认删除、按账号额度缓存隔离、隔离 HOME 环境、ACP 账号切换回收链路，以及面板 OAuth 的真实 loopback 回调与 token 落盘。`node scripts/preview-ui.mjs` 重新生成了 `.local-preview/quota-ui.html` 与 `.local-preview/settings-ux.html`，离线预览确认账号卡片、额度与状态布局在 390 / 760px 下无横向溢出。该验证仍是隔离回归与静态夹具：OAuth 使用假 Google 响应，未在运行中的 Desktop GUI 或真实 Google 账户上重新验收。

2026-10-30 的可靠性加固通过类型检查、**38 个文件 / 658 项测试**与构建。新增覆盖：额度 HTTP 请求超时折叠为可读错误（不留下永不结束的在途 promise）、401/403 按状态码而非错误文案触发一次换发重试、OAuth 元数据多份时按出现顺序配对、非法代理不再阻断插件装载（告警留痕且设置页仍可修正，启动时转成 `AGY_INVALID_PROXY`）、运行期代理地址变坏时按 Promise 契约拒绝、恢复启动失败归还磁盘 claim、中止错误码统一为 `AGY_ABORTED`、MCP 桥 Bearer 头改常数时间比较、zip 条目数与解压大小上限（含中央目录谎报大小时被拒）、单条畸形 JSON-RPC 帧只丢弃留痕而不再判死链路、带 id 的畸形响应立即拒绝而不是等满超时、留痕回调自身抛错不关链路、额度超时不足 1 秒报毫秒且主动中止与超时分开、非正数超时配置回落默认预算。

这些仍是隔离回归：没有实例化完整 DSH settings / Loader 服务，不能当作真实宿主端到端验收。真实 Desktop GUI、官方账号与非 Windows 实机仍未重新验收；zip 上限与畸形帧容错也没有用真实官方包或真实对端造过异常输入。

### 0.1.28 验证记录

2026-10-25 的源码工作副本执行 `npm run check`：TypeScript 检查、**36 个文件 / 617 项测试**与构建通过。新增覆盖手动预热的有界回收恢复、空模型配置保留目录、worker 元数据与档位合并、实际 worker 图片能力准备、额度信封与独立缓存竞态、Argon 共享额度、客户端失败保留快照，以及设置页分组与草稿行为。

同时使用本机 Chrome 无头截图检查 `.local-preview/quota-ui.html` 的浅色 / 深色及 750px 窄屏静态预览；预览数字全部为虚构，不访问真实账户或 DSH 页面。未执行发布、Profile 安装、Host 重启或真实 Desktop GUI / 官方账号验收。

## 维护与发布到 npm

现有工作流为 [Publish package](https://github.com/AlaIchhe/dsh-antigravity-acp/actions/workflows/publish.yml)，定义见 [publish.yml](https://github.com/AlaIchhe/dsh-antigravity-acp/blob/main/.github/workflows/publish.yml)。由 **push `v*` tag** 或 **workflow_dispatch** 触发；tag 名必须与 `package.json` 版本一致，否则在发布前失败。

流程：

1. 核对版本、锁文件、变更范围、文档与测试；确保目标版本未发布。
2. 提交并推送到目标分支，确认远端 SHA 与已验证内容一致。
3. 推送 `v<version>` tag（或在对应 ref 手动运行工作流）。现有任务使用 GitHub-hosted Ubuntu、Node 24，校验 tag 与版本一致，执行 `npm ci --ignore-scripts`、`npm run check`，再用 `NPM_TOKEN` 与 OIDC provenance 发布。
4. 观察这一次运行的 SHA、检查结果与 publish 步骤。失败时先判断是否已经产生远端副作用，不盲目重跑同一版本。
5. 在 registry 核对版本、dist-tag、tarball、仓库来源和 provenance；仅 workflow 返回成功还不足以宣称用户已装上该版本。

只读核对示例：

```console
npm view dsh-bundle-antigravity-acp version dist-tags --json
npm view dsh-bundle-antigravity-acp@0.1.39 version gitHead dist --json
```

工作流声明 `id-token: write` 生成 provenance；npm 认证优先使用仓库 secret `NPM_TOKEN`（当前发布账号的 granular token）。信任发布（trusted publishing）仍是更长期的方向，但本次绑定以 secret 为准：npm 上若以后配置了与 `AlaIchhe/dsh-antigravity-acp` + `publish.yml` 匹配的 trusted publisher，可以在确认 OIDC 可用后移除 secret。当前流程不创建 GitHub Release，也不安装 / 升级任何本机 Profile。

## 文档来源与已知覆盖缺口

- [DSH 插件安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish#install-into-a-profile)与 [Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)：公共 CLI 与桌面管理所有权；本次通过 Context7 检索，对照项目声明。公开主线不是已安装旧版本的保证。
- [ACP v1 初始化](https://agentclientprotocol.com/protocol/v1/initialization)与 [会话建立](https://agentclientprotocol.com/protocol/v1/session-setup)：本次 Context7 查询混入 RFD 草案，不能当成 v1 已核验；使用官方明确标注 v1 的页面与本地 SDK 类型作补充证据。
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)：本次 Context7 的 npm CLI 资料与官方页面交叉核对。`npm trust` 配置命令的版本门槛不同于既有工作流发布，不混淆这两者。
- 官方 `agy` CLI 的部分本地 JSON 报告没有完整公共文档，历史真实回包与本机实现只作标注的补充证据，不冒称完整官方 SDK 契约。

文档查证、静态检查、隔离测试、打包核查、真实调用和部署验收各自独立，不能互相代替。
