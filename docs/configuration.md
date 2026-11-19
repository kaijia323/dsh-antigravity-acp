# 配置与环境变量

[返回主页](../README.md) · [使用与排障](reference.md) · [开发与验证](development.md)

以下对应 **0.1.40**，以 [`src/settings.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/settings.ts) 的 Config 为准。字段均位于 `llm-antigravity-acp` 插件配置根级，不需要额外包装一层对象。设置页提供即时（volatile）字段与模型控制；`proxyBypass` 不提供界面控制项，并发 / 二进制 / 超时等普通配置在普通配置编辑器里修改。

## 配置清单

| 字段 | 默认值 | 作用与限制 |
|---|---|---|
| `agyCliPath` | 未设置 | 官方 `agy` CLI 路径，优先于 `AGY_CLI_BIN`、PATH 与平台默认位置；刷新时重新探测。 |
| `binaryPath` | 未设置 | 本地官方 ACP server 入口，优先级最高；指定但不存在会报错，不静默换来源。 |
| `extraArgs` | `[]` | 额外启动参数；不要传入会改变协议、工具隔离或认证边界的参数并假定仍兼容。 |
| `acpVersion` | `"1.4.0"` | 自动下载与缓存目标版本；不是 ACP wire protocol 版本。更换版本需重新验证厂商扩展与发行布局。 |
| `requestTimeoutMs` | `30000` | 普通 ACP 请求超时（毫秒），覆盖 stdin 写入与响应等待。 |
| `sessionTimeoutMs` | `120000` | `session/new` 与 `session/resume` 的请求上限（毫秒），与通用请求超时分开；官方 agent 冷启动 / 多 worker 并发时 30 秒不够（真机 2026-11-19 子代理 `session/new` 超时）。 |
| `handshakeTimeoutMs` | `120000` | ACP `initialize` 握手上限（毫秒）。官方 PyInstaller 进程冷启动实测约 52 秒、热启动约 10 秒，旧默认 15 秒会使冷启动登录超时。 |
| `authTimeoutMs` | `300000` | 交互式 `authenticate` 等待上限（毫秒），独立于普通请求超时。 |
| `promptTimeoutMs` | `1800000` | 单个 `session/prompt` 上限（毫秒）；工具 park 不表示上游 prompt 已结束。 |
| `bridgeParkSettleMs` | `50` | 并发 MCP 工具调用聚合窗口（毫秒）；不是工具执行超时。 |
| `modelOverrides` | `{}` | 按模型 ID 的目录设置，键是 DSH 选择器里的模型 ID：`enabled`（默认 `true`）决定是否出现在选择器，`name` 覆盖显示名，`target` 把该 ID 映射到官方模型 ID。思考强度不在这里（见下）。只作用于目录中已存在的条目，不新增自造模型。 |
| `proxyUrl` | 未设置 | 显式出网代理；留空先继承 Host 代理环境，再自动检测系统代理（Windows 注册表 / macOS scutil / Linux GNOME），都没有才直连。支持 HTTP/HTTPS CONNECT、SOCKS5、SOCKS5H。 |
| `proxyBypass` | 未设置 | 兼容既有配置的逗号分隔排除列表，支持域名匹配，不支持 CIDR；始终合并 localhost、127.0.0.1、::1。设置页不提供此控制项。 |
| `resumeSessions` | `true` | 插件或 Host 重启后用 `session/resume` 接上原 ACP 会话（不重放历史）。映射写在缓存目录的 `sessions.json`，只存会话 ID、cwd、已发送条数、输入/输出与路由 sha256 和时间戳，不存对话内容、system 提示或工具 schema。接不上就直接报 `AGY_SESSION_UNRECOVERABLE`，不再回退重建。 |
| `cancelGraceMs` | `30000` | 取消后等待 agent 确认停止的上限（毫秒）；`0` 表示不等待、立即回收进程。热启动约 10 秒，30 秒留出余量。 |
| `idleRecycleMs` | `900000` | 空闲 worker 保留时长（毫秒）。插件按「一对话一进程」运行、不设并发上限；空闲 15 分钟后回收进程，下次进入该对话用 `session/resume` 接回（真机验证：不重放历史）。`0` 表示不回收。 |

示例（不包含代理密码或账号材料）：

```json
{
  "acpVersion": "1.4.0",
  "resumeSessions": true,
  "proxyUrl": "http://127.0.0.1:7890"
}
```

### 会话复用与恢复

ACP 官方 agent 在同一会话内会保留上下文（2026-10-23 真机验证：同一 `session` 连发两条 prompt，第二条能复述第一条的暗号），并且声明了 `loadSession` / `sessionCapabilities.resume`。因此插件默认复用会话：

- 同一 DSH 对话的**普通聊天回合**校验输入前缀与上轮实际交付输出后，只发送新增消息；system、工具策略与历史不再每轮重放。收到 `finish` 即结束消费也会提交游标。
- 注入内容按 producer 与内容去重：仅省略相同的快照/目录/指令或已见召回材料；首次出现、变化或恢复旧版本的状态仍发送。真实用户消息、notice、relay 与未知类别不去重。
- **模型或思考强度变化不再重建会话**：既有 ACP 会话直接 `session/set_config_option` 应用新值。system 与工具目录在会话创建时固定，变化时沿用原会话（恢复映射优先于指纹完全一致）。
- 输入无法接上时：先尝试 `session/resume`；失败则按 `replayFallback`（默认开启）用**最近若干消息**（`replayMaxChars`，默认 120000 字符）新建 ACP 会话继续，日志写明「按有界历史重放新建会话」。关闭 `replayFallback` 才退回旧行为（报 `AGY_SESSION_UNRECOVERABLE`、不重放）。
- **换 worker / 空闲回收不丢会话**：连接池把同一对话换到另一 worker 时，旧 worker 关闭本地副本、映射交给新 owner 走 `session/resume`（`session/close` 后可恢复已验证）。
- 宿主注入块不算「历史不是前缀的追加」：`time-context`（`refreshIntervalMs` 默认 600s）、`runtime-context`、技能目录与工作区指令可以在任意两条真实消息之间出现，续轮与前缀校验都会剔除它们；落在工具结果之后的注入块也不会让续轮判定落空。
- 工具续轮期间还会出现两类真实 user 消息：宿主通知（`tool-jobs`、`subagent-settled` 等）与用户在忙时的插话（`busyEnter: steer`）。它们同样按「user 角色 + id 未曾发出」识别，不参与前缀比较；其中一次性通知与插话会附到最后一条工具结果投递给 agent，快照/目录/指令/召回类大块上下文跳过（后续回合仍可重新出现）。真正插在历史中间的 user 消息仍视为篡改并报错。
- 标题、压缩等一次性请求不参与复用，各自独立建会话，结束后尽力关闭。内存会话最多保留 64 条，磁盘映射最多 512 条（只存 ID 与指纹）。
- 同一对话优先粘在同一个 worker 上；换 worker 时靠磁盘映射 `session/resume` 接回。新对话优先用未被占用的 worker，没有空闲 worker 就新建一个。
- `resumeSessions` 验证输入前缀和上轮输出（不再因路由指纹变化拒绝）；恢复后应用当前模型与档位。恢复失败先回收连接，再把失败抛给宿主（不重建、不重放），映射保留供后续重试。
- 所有 worker 共用一个映射存储，串行提交且只修改本轮所属键。接管只换 owner、保留条目；旧 worker 不能覆盖或删除新 owner 的游标。映射格式 v2。
- 跨 Host 使用 `sessions.lock` 排他租约。另一 Host 已占用缓存时，本实例不读写恢复映射，只保留内存复用并记录警告；普通聊天不受影响。正常卸载 flush 后释放租约。若 Host 崩溃留下锁，不按时间猜测过期；确认使用此缓存的所有 Host 均已退出后，才可人工移除残留锁。

### 取消与进程保留

`session/cancel` 是通知，不代表官方 agent 的执行已经停止；插件因此先等 `cancelGraceMs` 让 agent 应答 `cancelled`（真机实测：确认前发新 prompt 会被明确拒绝）。取消**不销毁会话**：确认后保留进程与会话，下一轮按增量继续；超时未确认才回收，映射仍然保留、可 `session/resume` 接回（接不上就报错，不重放）。


- 先给 `cancelGraceMs`（默认 30 秒，热启动约 10 秒）让 agent 回应 `cancelled`；确认了就保留进程与会话（下一轮免冷启动，且按增量续上）。
- 宽限内没有确认、本地超时或通信失败 → 照旧回收；本地 promise 结束不等于 agent 已停止。`cancelGraceMs=0` 表示立即回收。
- 新轮不能撤销旧回合的取消宽限；需等待确认或完成回收后才使用连接。
- 保留期间 `idleRecycleMs`（默认 15 分钟）内没有新消息 → 回收，下次进入用 `session/resume` 接回。

实测（2026-10-23，官方 1.4.0）：同一会话空闲 60s、120s 后仍能复述上一轮暗号，响应耗时稳定（约 3s）；`usage_update.used` 持续累计（3463 → 3628 → 3745）。官方会话空闲 TTL 未知；ACP 会话上下文、Gemini 显式缓存与模型前缀缓存不是同一个保证。默认 5 分钟仅是本插件在启动延迟与常驻资源之间选取的回收策略，可自行调整或设 0 禁用。

## 环境变量

环境指 **运行插件的 Host 实际继承的变量**，不是任意终端当前的变量。只检查存在性和继承情况，不在反馈或日志里贴出敏感值。

| 变量 | 用途 |
|---|---|
| `AGY_ACP_BIN` | 官方 ACP 可执行文件覆盖，优先级低于 `binaryPath`。 |
| `AGY_ACP_URL` | 自动下载 URL 覆盖，仍受 HTTPS / `dl.google.com` 与不重定向约束；不赋予其它域名下载权限。 |
| `AGY_ACP_HOME` | 官方程序与独立运行目录的用户级安装根目录覆盖；应避开 Windows Low 完整性目录。 |
| `AGY_CLI_BIN` | 官方 CLI 路径覆盖，低于显式 `agyCliPath`。 |
| `AGY_ACP_ACCOUNTS_DIR` | 多账号根目录覆盖（默认 `~/.antigravity-acp-accounts`），内含 `accounts.json` 与每个隔离账号的 HOME。 |
| `AGY_OAUTH_CLIENT_ID` / `AGY_OAUTH_CLIENT_SECRET` | OAuth client 元数据覆盖，配对使用；不是模型 API Key，也不是用户 access / refresh token。通常不需要手动设置，不应随文档或截图分享。 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 与小写形式 | `proxyUrl` 未设置时的第一来源；没有环境变量时再检测系统代理。实际选择与注入见 [`proxy-env.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/runtime/proxy-env.ts)。 |
| `NO_PROXY` 与小写形式 | Host 代理绕过来源；本机 loopback 始终加入。 |
| `DSH_HOME` | 模型目录缓存所在宿主目录；**不是**默认官方程序与运行代码安装位置。 |
| `LOCALAPPDATA` / `USERPROFILE` / `XDG_CACHE_HOME` | 默认用户级安装位置的系统来源；不建议为本插件全局改写这些系统变量。 |

### 路径选择顺序

**ACP 程序：** `binaryPath` → `AGY_ACP_BIN` → 对应版本缓存 → 自动下载。手动覆盖先于自动平台映射，未知自动下载平台可使用明确指定的兼容程序。

自动下载的 zip 解压受三道上限约束：条目数 2000、单条目 512MB、解压总量 1GB。官方包解压后约 200–300MB、条目数十个，正常下载不会触及；超过任一道即报 `AGY_ARCHIVE_TOO_LARGE` 并放弃本次安装，不留半成品。这是下载域名白名单之外的压缩炸弹纵深防御。

**CLI：** `agyCliPath` → `AGY_CLI_BIN` → PATH → 平台默认位置。显式覆盖与候选读取细节以 [`agy-cli.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/runtime/agy-cli.ts) 为准；手动刷新会重新探测，不要求插件加载时 CLI 就已安装。

**代理：** 非空 `proxyUrl` 使用显式代理；留空先按 Host 环境、再按系统代理选择；都没有才直连。代理失败不会静默直连。[代理行为与诊断](reference.md#出网代理)

## 设置页可以做什么

页面分为「账号 / 模型」。账号页是账号卡片列表：每张卡片显示账号名 / 邮箱、`使用中` / `未登录` 标记、`使用此账号`、`登录` / `重新登录`、两段确认的 `删除`，以及该账号自己的额度明细（按额度组铺开：窗口名 + 百分比 + 余量条 + 重置倒计时，末尾 AI Credits；不再有「详情」折叠），额度在账号卡片挂载时自动读取。右上角「添加账号」直接发起浏览器 OAuth；等待期间同页显示授权链接与取消入口，授权回调自动完成，不需要粘贴授权码。ACP 连接在首次聊天时按需建立，不再提供手动连接 / 预热按钮；`cliQuotaEnabled`、会话复用/恢复与进程回收等调优项只在配置文件里，不再占设置页。模型页把目录里的模型按 Gemini / Claude / GPT / Argon / 其它家族分组，显示为可点击标签：点击切换显示 / 隐藏，隐藏项不在模型选择器中列出；不再维护逐模型的思考档位、显示名或官方 ID 编辑。

模型改动合并成一份 `modelOverrides` 在保存时提交；清空显示名或映射等于移除该字段，不会留下空壳配置。已经保存但当前目录没有的 ID 仍保留并标注「不在目录」，可搜索后继续修改或清除。

无修改且无状态消息时不显示保存操作区；编辑后出现与其它面板同款的细常驻操作面板，提供保存、未保存计数、撤销与刷新，冲突和结果也在此显示。修改配置中的出网代理或排除列表后需重载 Host；取消和退出不受草稿影响。

设置页打开时停在「账号」页。每张账号卡片挂载时自动读取该账号的额度；Host 缓存与在途请求按账号隔离，互不覆盖，不广播其它账号结果。与对话药丸共用读取器，旧请求不能覆盖新结果；失败保留缓存并标明原因。AI Credits 默认不查询且不显示占位区块，打开 CLI 取数后属于官方 CLI 账户。目录刷新遇到暂时回收故障时会在本次操作内补试一次，持续失败仍拒绝复用旧进程。

## 多账号与隔离 HOME

- **账号存储**：账号列表在 `~/.antigravity-acp-accounts/accounts.json`（可用 `AGY_ACP_ACCOUNTS_DIR` 覆盖）；每个隔离账号是同目录下的一张 HOME，登录态文件权限 0600。该目录刻意不放在 `$DSH_HOME` 下，避免 Windows 上整棵 Low 完整性树导致官方 ACP server 写不进凭据。
- **系统账号**：固定第一位，使用真实 HOME，登录态来自本机官方 `agy` CLI。插件只读导入，面板不提供对它的 OAuth 重新登录，也不会改写官方 CLI 的 `antigravity-oauth-token`。想给系统账号换号，请在官方 `agy` 里重新登录后重连。
- **新增账号**：`添加账号` / `登录` 走 Google OAuth（PKCE + 本机 `127.0.0.1:51121/oauth-callback`，state 校验，5 分钟超时）。授权码换 token 后写进该账号自己的 `~/.gemini/antigravity-cli/antigravity-oauth-token`，同时生成 ACP server 使用的 `.gemini/antigravity-acp/` 文件；登录过程不需要先安装/下载官方二进制。
- **切换语义**：点「使用此账号」只影响之后的连接；已建立且正在跑回合的 ACP 进程不会被立刻杀掉，下一次该 worker 启动时按新账号回收重建。重新登录同一账号会让它的代际 +1，同样在下一次启动时生效。
- **删除**：只删除插件在账号根目录下创建的隔离 HOME；系统账号不可删除。删除当前账号会回落到系统账号。
- **额度**：HTTP 额度按账号 HOME 读取；开启 `cliQuotaEnabled` 时，`agy -p /usage|/credits` 也带该账号的 HOME 启动。药丸只跟随当前账号，面板可逐账号拉取；切换 / 登录 / 删除后药丸会重新取数。
- **已知边界**：面板登录的 OAuth 回调固定在 Host 的 `127.0.0.1:51121`，要求**浏览器与 Host 在同一台机器**；从另一台设备访问 DSH Web 时，浏览器会把 localhost 指向自己，回调到不了 Host（本版本没有手工粘贴授权码的回退，可先在本机完成登录或用系统账号）。macOS 的官方 CLI 可能优先使用系统钥匙串，隔离 HOME 未必能完全隔离 token；Linux 上通过把 `DBUS_SESSION_BUS_ADDRESS` 指向账号目录内不存在路径来阻断桌面 Secret Service；Windows 同时改 `USERPROFILE` / `HOMEDRIVE`+`HOMEPATH`。OAuth 使用官方二进制里审计过的 client；从二进制提取不到时回落到 `@cortexkit/antigravity-auth-core` 的同一对。

不提供目录条目删除或付费 Credits 开关；账号切换与删除见上。停用只是不列入选择器，已知模型的显示名、上下文容量与路由仍保留。思考强度不在配置里：它是 agent 声明的模型元数据（`thought_level` 选项），由 DSH 思考强度菜单选择后逐个会话写入，不维护第二份档位配置；旧配置文件里残留的 `effort` 键会被忽略。只读 Profile 禁止修改；外部刷新不会覆盖未保存草稿，保存失败保留输入。
