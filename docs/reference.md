# 使用与技术参考

[返回主页](../README.md) · [配置](configuration.md) · [更新记录](changelog.md) · [开发与验证](development.md)

本文对应 `dsh-bundle-antigravity-acp` **0.1.40**。安装或连接成功不等于真实模型生成、图片识别或所有平台已验收。

## 安装与更新

### npm 包

```console
# 公共 CLI 的 Web profile 示例
dsh plugin --profile web add dsh-bundle-antigravity-acp

# 需要固定版本时
dsh plugin --profile web add dsh-bundle-antigravity-acp@0.1.39
```

更新时通过目标插件管理器选择本包的目标版本，或使用目标 CLI 支持的单包更新方式；先核对该入口的 `plugin --help`。不要用不限定包名的批量更新命令替代一次单插件更新。

### 本地产物

在源码仓库完成构建并打包后，也可安装本地 tarball：

```console
dsh plugin --profile web add ./dsh-bundle-antigravity-acp-0.1.39.tgz
```

文件名以实际打包结果为准；构建与打包步骤见[开发说明](development.md#构建与本地打包)。本仓库现有发布工作流发布到 npm，**不生成 GitHub Release tarball**，因此没有可用的 `releases/latest/download/...` 安装入口。

### Desktop 与启用

- `web` 只是文档示例，不代表实际安装目标。
- **DSH NEXT Desktop 使用随包 DSH Desktop CLI 管理其已初始化的 `desktop` Profile**；独立 npm 公共 CLI 不能代替它。按目标版本要求完全退出 Desktop，执行单包操作，再重开。应用内插件管理页也是可选入口。
- 安装与启用分开。按部署方式重载或重启，让 Host 和 Client 一起生效；仅刷新网页不保证后台已更新。
- 不在受管 Profile 中裸跑 npm / pnpm，不手工编辑其 manifest、锁文件或 bundle 清单。
- 安装后核对包版本、bundle 启用、provider 注册和设置页，再测试连接、生成与工具调用；目录存在或 CLI 返回成功不足以证明运行生效。

官方参考：[插件发布与安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish#install-into-a-profile)、[Desktop CLI 与安装所有权](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)。公开主线文档不是每个旧版安装入口的兼容证明。

## 第一次连接

打开 **设置 → Antigravity ACP**。默认继承 Host 环境变量或系统代理；都不可用时在配置中设置 `proxyUrl` 后重载 Host。

| 操作 | 做什么 | 不做什么 |
|---|---|---|
| 刷新模型目录 | 优先查询官方 CLI；没有 CLI 时使用已有 ACP 登录态进行有界目录发现 | 不暗中触发交互登录，不自动替换当前会话的已选模型 |

ACP 连接在首次聊天时按需建立，不提供手动连接 / 预热入口；设置页只展示目录与账号卡片，不能用上一次成功状态代表当前进程仍存活。

运行细节（启动、凭据准备、握手、建会话、选模型、首块、首个工具及续轮耗时）写在 Host 日志中，设置页不再单独提供诊断面板。额度与 Credits 在设置页「账号」卡片中查看：每个账号的额度明细直接铺开（分组 + 窗口 + 百分比 + 余量条 + 重置时间 + AI Credits），挂载时自动读取。对话输入框旁的药丸只是纯展示：显示当前所选模型所属家族的额度（族名 + 最低窗口百分比 + 迷你条），不可点击；Argon 有独立额度组时只读自己的组。

目录刷新可从一次暂时回收故障中恢复，但持续无法确认进程退出时仍会失败，不复用未确认退出的连接。会话配置缺少模型选择器时保留已知目录，不把一次不完整响应当成模型已下架。

## 模型目录与请求项

模型目录来自会话 `configOptions`、`config_option_update` 与官方 CLI 的只读 `agy models`。`initialize` 本身不是无需登录即可获取完整模型目录的接口。没有缓存时目录可以为空，应先显式连接或刷新。

- 观测目录写入 `$DSH_HOME/cache/antigravity-acp/catalog.json`，只含模型信息，不含凭据；CLI 目录使用同目录的 `cli-models.json`。版本不符或损坏的缓存不作为有效目录。
- 设置页的模型列表按 Gemini / Claude / GPT / Argon / 其它家族分组，只做显示 / 隐藏：点击模型标签切换，隐藏项不在选择器中列出。列表 = ACP 观测目录 ∪ 官方 CLI 清单，CLI 的档位化原始行（`…-high`）会先折叠成家族再合并，所以同一模型不会按思考档位分行。停用不删除目录条目；`modelOverrides` 里的显示名 / 官方 ID 映射仍按配置生效，但不再提供 UI 编辑。
- 映射（`target`）优先于路由回调；没有映射时才按「显式选择 → `thought_level` 选项」决定最终配置值。
- **思考强度是模型的元数据，不是模型 ID 的一部分**：官方 ACP 1.5 起把档位声明成独立的 `thought_level` 选择器（本机 `agy acp` 1.5.10 实测：`model` 只给家族 id，`thought_level` 给 Low / Medium / High，切到 Gemini 4 Hydrogen 后多一档 Extra/`xhigh`）。插件据此声明 `reasoning.efforts`（id 与名称都取 agent 声明），于是 DSH 的 `/model` 菜单与模型按钮上有档位可选；选模只发家族 id，档位另写一次 `session/set_config_option`，请求的档位不在当前选项里时按 low → medium → high → xhigh 就近收敛，不把未知值发出去。
- 兼容旧 agent：没有 `thought_level` 时，官方档位化目录（`claude-opus-5-5-high`）折叠成家族并退回「档位后缀」路由，缺档取最近档位，未指定通常使用 `medium`。`gpt-oss-120b` 家族不列入选择器。
- 目录里没有任何档位变体、agent 也没声明 `thought_level` 的家族 id **不声明**思考强度菜单（省略 `reasoning` 字段）：宿主把 `efforts: []` 判为非法元数据（`INVALID_MODEL_REASONING`）并使该模型不可用，空数组不等于「没有档位」。
- 旧 `server-default` 路由仍兼容：默认沿用上游模型，配置了映射时才写入映射目标；不再新增占位选择项。
- **用满 agent 声明的 ACP 能力**：`_meta.antigravity.systemPrompt.append` 为 true 时，system prompt 随 `session/new` 的 `_meta` 交给 agent 追加到它自己的系统提示（实测 1.5.10 生效），prompt 里不再重复包 `<dsh-system>` 文本块；`sessionCapabilities.resume` 为 true 时跨进程恢复用 `session/resume`（不重放历史），没有该能力就报错（不再退回 `session/load`）；配置了 `agentMode` 且该 mode 出现在会话的 `availableModes` 里时才发 `session/set_mode`。fs / terminal / `session/request_permission` 仍然一律拒绝——工具必须回 DSH 审批执行。
- 上下文容量与占用不填猜测值。`usage_update.size` 才作为窗口、`usage_update.used`（Tokens currently in context）才作为占用上报给宿主并缓存；首次观测前未知。ACP 的 `PromptResponse.usage` 是**本回合内所有内部模型调用的求和**（`inputTokens` / `cachedReadTokens` / `outputTokens` 都是本回合各次调用之和，`totalTokens` 恰等于本轮各条 `usage_update.used` 之和），工具回合会把 prompt 侧统计放大成上下文窗口的数倍，所以不能当某一轮的上下文占用；本插件目前不转发它。
- 模型、容量与图片能力在 worker 间同步；不因增加 worker 就虚构新模型权益。

| 请求项 | 行为 |
|---|---|
| `reasoningEffort` | 思考强度；有 `thought_level` 时直接写入该配置项，旧 agent 则是档位路由键 |
| `maxTokens` | 忽略；宿主标题等内建流程也会携带此项，输出限制由官方 agent 决定 |
| `temperature` / `stop` | 记录警告并忽略；值不生效，不冒充采样控制已满足 |

## 并发与工具续轮

工具续轮期间 DSH 会追加两类真实 user 消息：宿主通知（`tool-jobs` / `subagent-settled` / `plan-mode` 等）与用户在忙时的插话（`busyEnter: steer`）。插件按「user 角色 + id 未曾发出」识别尾部追加，不参与续轮前缀比较；一次性通知与插话随最后一条工具结果投递给 agent，快照 / 目录 / 指令 / 召回去重跳过。历史上中间插入的 user 消息仍视为篡改并报 `AGY_SESSION_UNRECOVERABLE`。`session/new` 与 `session/resume` 使用独立的 `sessionTimeoutMs`（默认 120 秒），与普通请求的 30 秒分开。

**一对话一进程，不设并发上限**：每个 DSH 对话按需启动自己的官方 ACP 进程，没有容量上限、没有等待队列、没有排队超时。会话数量不受限制，进程数靠空闲回收收敛到「活跃对话数」（`idleRecycleMs`，默认 15 分钟）；回收后下一次进入该对话用 `session/resume` 接回，**不重放历史**（真机验证：`session/close` 之后也能 resume 并继续）。

为什么不是单进程多会话：真机探针确认官方 agent 单进程能并发多个会话（5 路并发、含 3–4k 输出的长回答都通过），但每条链接各自持有 MCP 桥、工具授权代次与 prompt 生命周期；共享一个进程会让一次卡死/崩溃带走所有对话。这也是为什么保留「一对话一链接」，而删除的是「容量与队列」。

标题（`session-title`）不新建进程：没有空闲连接时直接放弃，宿主保留兜底标题；压缩（`compaction`）需要连接，会按需新建。

同一会话、同一用途的重叠请求串行；保留的工具回合仍归原 worker。同会话同步压缩可回到该 worker，不等待自己的工具结果。原工具结果拥有优先回填路径，不会仅因无关队列已满而被拒绝。`session-title` 与 `compaction` 这类**一次性请求**的调用方不会回喂工具结果：这类回合收到工具调用时立即以错误结算该次调用（不 park），避免 worker 一直处于 busy、既不空闲回收也不释放池位。

工具链路：

1. 插件通过宿主 `ctx.subprocess` 以 stdio 启动官方 ACP server。
2. 会话使用厂商扩展 `_meta.antigravity.enabledTools: []` 关闭内置工具，使用 `eagerMcpServers: ["dsh-tools"]` 提供当前 DSH 工具 schema。此扩展的默认适配基准是官方 server 1.4.0，不保证任意版本同样实现。
3. 私有 MCP 桥仅绑定 `127.0.0.1`，新建带工具的 ACP 会话时轮换 token 与授权代次；同一会话复用时保留授权，目录/归属变化则丢弃该会话（后续回合报 `AGY_SESSION_UNRECOVERABLE`，需新开）。
4. ACP 权限提示只对已识别私有桥请求选择 `allow_once`，不会自身产生 DSH 调用；真正的 `tools/call` 到桥后才挂起，并以 `tool-call` 交给 DSH。
5. DSH 负责校验、审批、执行；工具结果按调用 ID 匹配，携带 `isError` 回填同一 ACP prompt。支持乱序结果与后续批次。

桥可按 schema 修正常见、无歧义的参数别名，如 `path` / `AbsolutePath` → `file_path`、`CommandLine` → `command`。不覆盖已有字段，不猜多目标映射，不换算超时单位，不编造缺失说明。缺必填键时返回 `AGY_BRIDGE_INVALID_ARGUMENTS` 与正确签名，不进入 DSH；字段类型与取值仍由 DSH 校验。

续轮会校验模型、思考强度、system、工具 schema、历史前缀与上轮实际输出。变更后取消旧 prompt，并让这一轮报 `AGY_SESSION_UNRECOVERABLE`（不按新历史重放）。宿主注入块（`time-context` / `runtime-context` / 目录 / 指令，即 `source.form` 为 `snapshot`/`catalog`/`instructions`/`recall` 的 user 消息）不参与前缀比较，也不阻挡续轮：它们由 pre-step 在请求生成时追加，位置与数量不由模型决定。真实用户消息、压缩检查点与模型选择记录仍按普通历史校验。`finish(tool-calls)` 只封住当前 DSH 输出，不代表官方 prompt 已结束；封口后到达的内容留给续轮。

普通用户回合默认复用 ACP session，校验输入前缀和上一步实际输出，只发增量；编辑回答、外部 provider 的额外输出或路由变化会让这一轮报 `AGY_SESSION_UNRECOVERABLE`（不重放）。选模（`session/set_config_option`）只在**本会话自己**声明过 model 选择器、且当前值已经是目标值时短路：新会话省略 `configOptions` 时不会拿别的会话的 `currentValue` 短路，否则新会话会静默跑在 agent 默认模型上。`resumeSessions` 开启跨进程恢复（默认开启），恢复后校正模型；文本历史信封不等同于模型 API 的原生角色消息。上游 `end_turn` 没有可见文本或工具调用时返回 `AGY_EMPTY_RESPONSE`，仅思考或进度通知不算成功。

ACP fs / terminal 与未知原生权限请求始终拒绝并记录，但不因拒绝次数终止整个对话，模型仍可改用 DSH 工具。已识别私有桥调用的 `kind` 仅用于展示；权限提示参数只供诊断，不因缺失或包装差异阻断，真正执行仍取自后续 `tools/call`。协议能力与权限拒绝**不是操作系统沙箱**，不证明官方二进制只能执行被协议观察到的操作。

## 图片输入

需要宿主附件服务与上游 `promptCapabilities.image` 同时可用。插件在调用准备阶段发现能力，避免提前按 text-only 投影丢掉图片。

- 当前 / 历史消息与工具返回图片均通过附件引用读取，校验附件 ID、媒体类型、字节数及非空内容，再转换为 ACP / MCP 图片内容。
- 支持 PNG、JPEG、WebP、GIF；不自行下载远程图片 URL，不任意读取用户文件来替代附件服务。
- 附件服务不存在时保留文本能力，不声明图片输入；意外收到不能处理的图片返回 `AGY_IMAGE_UNAVAILABLE`，引用与数据不一致返回 `AGY_INVALID_IMAGE`。
- 已被宿主 offload 的图片会明确说明本次未发送像素；不保证可以重建已卸载内容。
- 不支持的文件引用应先由 DSH 投影为可读文本；不声称支持音频、视频或图片生成。

协议依据：[ACP v1 初始化与能力协商](https://agentclientprotocol.com/protocol/v1/initialization)、[会话建立](https://agentclientprotocol.com/protocol/v1/session-setup)。SDK 版本 1.4.0 与 wire protocol v1 分开看待；v2 / RFD 草案不作为当前实现契约。

## 登录态与额度来源

### ACP 认证

优先复用本机已有 ACP 凭据。需要导入时，只读 `~/.gemini/antigravity-cli/antigravity-oauth-token`，换发后写入官方 ACP 使用的 `~/.gemini/antigravity-acp/acp_token.json`，并在 `settings.json` 缺少认证方式时合并 `auth.type = oauth-personal`。保留既有设置与用户指定的其它认证方式，不覆盖无法解析的设置文件。

这意味着插件**可能读写本机认证材料**，不是“完全不碰凭据”。CLI 源文件不由插件改写；有可用登录态时跳过浏览器授权。没有可用登录态且本次允许交互时才退回官方 OAuth。非交互目录刷新不会暗中弹登录页。CLI 登录不会由 ACP 登录反向补齐。

凭据文件使用临时文件与重命名写入，POSIX 请求 `0600`；Windows 依赖目录 ACL，不宣称文件加密或仅靠 mode 就完成隔离。OAuth client 元数据来自显式环境变量或本机官方分发物，这是兼容性取数路径，不保证官方内部格式永远稳定。

### 多账号

账号列表持久化在 `~/.antigravity-acp-accounts/accounts.json`（`AGY_ACP_ACCOUNTS_DIR` 可覆盖）。第一位是**系统账号**：使用真实 HOME，只读导入本机官方 CLI 登录态，不能被删除，也不提供面板 OAuth 重新登录。其余是**隔离账号**：每个账号一张 HOME，`~/.gemini/antigravity-cli/antigravity-oauth-token` 与 `.gemini/antigravity-acp/` 都写在里面。

面板的 `添加账号` / `登录` 直接跑 Google OAuth：PKCE、本机 `127.0.0.1:51121/oauth-callback`、state 校验、5 分钟超时；回调后换 token、读 userinfo（邮箱）、写两份登录态文件，不要求本机先有官方二进制或 CLI。登录期间 Host 只返回授权 URL 与阶段，不返回 code、token 或文件路径；取消会关闭监听并清理暂存目录。

面板 OAuth 的回调固定在 Host 的 `127.0.0.1:51121`，浏览器必须与 Host 同机；远程访问 DSH Web 时没有手工粘贴授权码的回退。ACP 启动、只读 CLI（`models` / `/usage` / `/credits`）与 HTTP 额度都按当前账号解析 HOME：Linux 阻断系统 D-Bus，Windows 同时改 `USERPROFILE` / `HOMEDRIVE`+`HOMEPATH`，macOS 可能仍受系统钥匙串影响（见配置文档的已知边界）。切换账号或重新登录同一账号后，下一次 worker 启动会回收旧链路再按新账号创建；正在跑的回合不被打断。

### 额度药丸与 AI Credits

选中 `antigravity-acp` 时显示；药丸保留原尺寸，只显示一个额度入口。展开详情按模型组分隔，各时间窗口在可用宽度内并排显示百分比、细进度条与重置时间，Credits 采用紧凑布局。药丸位于模型选择器左侧，按已保存的官方映射匹配 Gemini、Claude/GPT、Gemini 4 Argon 额度组；未知型号与旧 `server-default` 不借用其它模型数字（显示名不影响分组）。

展开固定展示三个组；缺数据标为未提供，显示每窗剩余百分比、重置时间、当前模型、缓存状态与刷新。未开启 CLI 积分查询时 AI Credits 区块整体隐藏，开启后的查询失败仍展示；支持深浅主题、Escape 与外部点击关闭。

药丸外观交互参考 [dsh-subusage](https://github.com/KouzakiUmi/dsh-subusage) 0.23.0（MIT）：正常只显示当前模型窗口的迷你条，额度偏少、用尽、缓存或失败时增加简短状态，详情有关闭按钮。本插件独立取数，不依赖 subusage 服务，也不读取其它订阅。

设置页每个账号卡片用与药丸同款的迷你条展示额度组与窗口百分比，重置时间与 Credits 收在「详情」里；账号卡片挂载时读取该账号，与药丸共享读取器但不广播其它账号的结果；切换 / 登录 / 删除账号后药丸重新读取当前账号，迟到结果不覆盖新账号。顶部保存栏随滚动可见，外观与其它面板一致，修改网络设置后先保存再连接。

翻转「用 agy CLI 查询额度」会让缓存身份变化并重取；额度缓存按账号隔离，在途旧结果不覆盖其它账号或切换后的当前账号。AI Credits 默认不查询；打开开关后才来自对应账号的官方 CLI 登录态。

| 数据 | 优先来源 | 回退 / 限制 |
|---|---|---|
| 套餐额度（打开 CLI 取数） | 该账号 HOME 下 `agy -p /usage --output-format json` 的 `command.data.groups[].buckets[]` | 未找到 agy 时回落 HTTP（同样读该账号 HOME） |
| AI Credits | 仅当 `cliQuotaEnabled` 为真时：`agy -p /credits --output-format json` 的 `command.data.remaining_credits`，可选 `plan_name` | 默认不查询（`cli-disabled`，界面隐藏区块）；开关开启但 CLI 缺失等故障以 `cli-unavailable` 等错误码显示，不从套餐额度推算 |

ACP 目录发现沿用排队、握手与会话请求各阶段的超时，不再额外套用普通请求或客户端 60 秒总期限。目录发现和能力准备优先复用已有空闲 worker，不因聊天粘性额外扩容。

CLI 额度 / 余额命令各有 45 秒超时，HTTP 回退的换发与 Cloud Code Assist 请求各有 20 秒超时；并发刷新合并、有效缓存不重复取数。超时是为了不让一次挂起的请求把「在途取数」永久占住——并发的药丸刷新与手动强制刷新会合并到同一个在途结果上，不设上限就会一直停在读取中。同一份 20 秒预算也覆盖启动期凭据换发（登录态过期时 ACP 启动前的换发走同一实现），那里原本同样是无限等待，代理不通会表现为启动卡住。额度与 Credits 独立缓存、独立标记更新时间与错误；查询失败可保留旧值但明确标缓存，上游明确无账户信息时移除旧值。Credits 校验成功状态、命令与非负安全整数金额，不用 `num_turns` 判断报告是否有效；真实零显示 0，缺字段不变成零。不请求购买、不自动开启 `useG1Credits`。

HTTP 额度回退只读 CLI 登录材料，换发 access token 仅留内存，不写回 CLI 文件。所有 CLI 进程经宿主受管通道启动。日志与错误对 OAuth URL、Bearer、代理密码和结构化 token 脱敏，不回显正文或工具参数值。

**历史实测，不是 0.1.24 GUI 验收：** 2026-10-16 本机 CLI `/usage` 返回三个组的 weekly / 5h 窗口；同账户 HTTP 回退曾返回产品授权 403。2026-10-22 既有 CLI `/credits` 记录为成功、零模型回合 / 零用量。当前任务未重跑这些在线调用；不能保证所有旧 CLI 支持相同 JSON 形态。

官方参考：[安装与认证](https://antigravity.google/docs/cli/install.md)、[无头模式](https://antigravity.google/docs/cli/headless.md)、[AI Credits](https://antigravity.google/docs/cli/commands/credits.md)。本地 JSON 契约与官方 TUI 说明的覆盖范围不同。

## 运行目录与下载安全

默认官方 server **1.4.0**，不随 registry 自动升级。自动下载限定 HTTPS / `dl.google.com`，拒绝任何重定向，按流写入临时文件；解压检查绝对路径、`..`、盘符、反斜杠与逃逸路径。成功后提交缓存，失败清理本次暂存。官方未提供校验和，不能据此宣称签名 / 校验和验证通过。

二进制默认**不放在 DSH home**：

- Windows：`%LOCALAPPDATA%\dsh-antigravity-host\<版本>\`；缺少该变量时按用户目录回退。
- macOS / Linux：`$XDG_CACHE_HOME/dsh-antigravity-host/<版本>/`，其次 `~/.cache/dsh-antigravity-host/<版本>/`。

Windows 的 Low 完整性目录可能导致官方进程不能保存用户级凭据，也可能降低运行代码目录的信任级别。插件启动前只读探测二进制与运行目录，识别到 Low 标签返回 `AGY_BINARY_LOW_INTEGRITY`；探测失败本身不等于安全校验成功，也不会自动修 ACL。

onefile 临时展开使用用户级根目录内独立的 `runtime/instance-*`，不使用 DSH Low 临时目录。**进程生命周期交给宿主的 `ctx.subprocess`**：启动用 `spawn`，终止用 `terminate()` + `waitForExit()`（provider 证明整个进程范围静默），确认退出后删除该临时目录。插件不再写 owner 文件、不再做 pid 存活探测、也不扫描清理历史目录——残留目录由用户停止相关进程后人工清理。

自动平台映射参考[官方 registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)：Windows `.exe`、POSIX `.par`、macOS 目录 `macos`、ARM64 发布后缀 `arm64`、Linux 默认参数 `--uid=`。这些是发行布局与测试契约，不代表所有平台实机验证；手动本地二进制覆盖先于自动平台映射。

## 出网代理

`proxyUrl` 支持 `http` / `https` / `socks5` / `socks5h`，缺 scheme 按 HTTP，不支持 SOCKS4。留空时依次继承宿主代理环境、自动检测系统代理（Windows 注册表 / macOS scutil / Linux GNOME），都没有才直连。

- 显式代理先验证，再进行下载、OAuth 或启动；非法地址不回显输入材料。**保存的地址非法不会让插件装载失败**：装载期只记一条告警并继续加载，设置卡片因此仍可打开、修正并保存，不必去手改宿主配置文件。真正用到代理的操作各自失败——启动 ACP 报 `AGY_INVALID_PROXY`，下载 / 换发 / 额度取数按各自的可读错误折叠。修正保存后下一次操作即读取新值；已有 ACP 进程保留原启动环境。
- 官方进程通过环境注入大小写两套代理键，因为宿主受管子进程会清理父环境。
- `proxyBypass` 与 `localhost` / `127.0.0.1` / `::1` 合并，loopback 始终排除，保证 MCP 桥和 OAuth 回调不绕出本机。
- 插件自身下载、OAuth 与 HTTP 额度请求使用直接依赖 `undici`；显式代理不可用就报错，不静默退回直连。SOCKS5 域名经代理解析。
- 改动后按部署方式重载 Host / 重启 Desktop，确保新进程读到配置；不把页面刷新当作代理已更新。
- 卸载关闭本插件持有的连接池，不影响其它插件的网络资源。

## 设置页实现边界

设置读取 / 修改使用宿主 `remote.settings.describe()` / `mutate()`，provider 状态使用 `remote.llm.listProviders()`。模型、账户连接与额度通过本包贡献的 `remote.agyQuota` 提供；不调用不存在的 `remote.llm.listModels`。

客户端先挂载贡献型 remote。`remote.settings` / `remote.llm` 是宿主已有服务，必须声明依赖；本包的 `remote.agyQuota` 需等挂载后出现，不能预先作为硬依赖阻止自身挂载。

设置草稿与远端快照分离，只提交已修改字段，支持清空。模型列表整份 `modelOverrides` 作为一个字段参与脏值与冲突判断，规范化后比较，避免键序或写回默认值被误判为未保存修改。外部更新产生冲突时提示并可恢复远端值；保存失败保留草稿。加载、只读与保存期间禁用相应编辑，不提供目录条目删除或付费开关；账号切换与删除见[多账号](#多账号)。

## 已知限制与绕过

下面这些来自 ACP 官方 agent 或协议层，插件不能完全消除；写在这里避免被误当成故障。

| 限制 | 现状 | 绕过 / 处理 |
|---|---|---|
| 没有单轮 token 用量 | ACP 只给了会话累计的 `PromptResponse.usage` 和当前占用的 `usage_update.used/size`，没有「本轮 prompt 用量」。 | 占用用 `usage_update.used` 上报；累计值不冒充本轮用量，也不估算、不伪造计费数字；额度以官方客户端/额度药丸为准。 |
| 工具参数非流式 | ACP 桥在工具被调用后才拿到完整参数，界面里工具调用一次性出现。 | 协议没有增量参数通道，暂无。 |
| 标题 / 压缩走当前 provider | DSH 用当前模型生成标题、做压缩，各自新建一次 ACP 会话（约 3–20 秒、消耗额度）。 | 标题超时已收紧到 90 秒、压缩 10 分钟；可在 DSH 侧关闭自动标题或改用更便宜的 provider。 |
| `temperature` / `stop` 不生效 | ACP v1 没有对应会话通道；插件记录警告并忽略，不再整单失败。 | 需要采样控制时使用官方 agent 自身的会话配置。 |
| 上下文去重 | 相同 producer 的未变化快照/目录/指令与已见召回材料不重复发送；新内容、变化和状态回滚仍发送。 | 不再整类跳过注入；未知来源保守发送。 |
| 取消后的进程 | `session/cancel` 只是通知；插件等 `cancelGraceMs` 内的 `cancelled` 应答，确认后保留进程与会话（真机实测确认前发新 prompt 会被拒绝），超时未确认才回收。 | 一般无需操作；确认慢的账号可调大 `cancelGraceMs`。 |
| 恢复缓存由其他 Host 占用 / 崩溃残留锁 | 排他租约不可取得时，仅禁用本实例的磁盘恢复，不影响普通聊天；不自动抢锁。 | 使用独立缓存目录，或确认相关 Host 全部退出后清理残留 `sessions.lock`。 |
| 对端发来畸形 JSON-RPC 帧 | 既没有 `method`、也不是合法响应形状的帧此前会让整条链路判死（在途请求全部报 `AGY_LINK_CLOSED`）。现在只丢弃该帧并写一条告警。 | 看到「已丢弃无法路由的 JSON-RPC 帧」时核对官方 server 版本；单帧丢弃不影响本轮结果。 |

## 排障

| 现象 / 错误码 | 可能原因 | 检查与处理 |
|---|---|---|
| `AGY_BINARY_LOW_INTEGRITY` | 二进制或运行目录带 Windows Low 标签 | 将 `binaryPath` / `AGY_ACP_HOME` 指向合适的用户级目录；不要自动改 ACL 或删除旧缓存。先停止相关进程，再人工检查遗留目录。 |
| `AGY_BINARY_MISSING` | `binaryPath` / `AGY_ACP_BIN` 都没配，缓存里也没有对应版本（插件不再自动下载） | 配置 `binaryPath` 或把官方二进制放进缓存目录。 |
| 已有解压目录却缺少有效可执行文件，下载后仍重命名失败 | 同版本缓存损坏，当前不会自动删除并覆盖该目录 | 先确认相关进程已停止，再人工核对该版本缓存；也可使用明确指定的有效 `binaryPath`。不要在官方进程活跃时清理它。 |
| `AGY_AUTH_TIMEOUT` | 需要浏览器授权但未在期限内完成，或上游认证失败 | 检查官方登录状态、浏览器和代理；日志不要附完整 OAuth URL。 |
| 目录为空 | 握手不等于已建会话 | 检查账号登录态并刷新目录；检查具体错误而不是反复发送聊天。 |
| `AGY_INVALID_PROXY` / 代理相关失败（连接 Google 失败、换发或额度取数超时） | 代理格式、出口或宿主环境继承问题 | 非法地址不再阻断插件装载：在配置中修正 `proxyUrl` 后重载 Host 即可。核对目标 Host 实际继承的环境；保存后已有 ACP 进程仍保留原启动环境。 |
| `AGY_QUEUE_TIMEOUT` / `AGY_QUEUE_FULL` | worker 忙或保留工具回合，队列超时 / 已满 | 完成或取消旧工具审批；查看排队状态，按资源与账户限制调整并发。 |
| `AGY_INCOMPATIBLE_PROTOCOL` / `AGY_UNSUPPORTED_CAPABILITY` | 协议版本或 MCP 等能力不满足 | 使用兼容 ACP v1 的官方 server；不只修改版本号就假定厂商扩展兼容。 |
| `AGY_IMAGE_UNAVAILABLE` / `AGY_INVALID_IMAGE` | 附件服务 / image capability 不在场，或附件引用不一致 | 重新连接检查能力与附件；不要将文字描述误当已发送图片像素。 |
| `AGY_BRIDGE_INVALID_ARGUMENTS` | 参数别名修正后仍缺必填键 | 按错误中签名补齐；模糊别名不由桥猜测。 |
| `AGY_EMPTY_RESPONSE` | 上游结束时没有可见文本或工具调用 | 查看结束原因与 Host 日志；不把仅思考、进度或空白当成功。 |
| `AGY_ARCHIVE_TOO_LARGE` | 下载的 zip 条目数或解压后大小超过上限 | 官方包远低于上限；出现此码说明下载源异常，先核对 `AGY_ACP_URL` 未被改指他处，再重新下载，不要放宽上限。 |
| 额度 / Credits 不完整 | CLI 未登录、旧版本缺字段、HTTP 产品授权不足或网络失败 | 分别查看额度与 Credits 状态，检查 `agyCliPath`；ACP 登录不等于 CLI 登录。 |
| 药丸完全消失 | 未选择本 provider，或 Client / remote 未装载 | 先确认选中 `antigravity-acp`、Host 与 Client 同版本；开发时核对 `$mount` 与依赖，避免让贡献型 remote 等待自身。 |
| 运行目录积累 | 被强杀后残留 | 插件不再自动回收历史目录（不再做 pid 探测）；停止相关进程后人工删除。 |

异常失败会撤销桥授权并回收受管进程；正常应答的 refusal / 空回复可保留自洽连接。取消后先等 agent 的正常停止应答（`cancelGraceMs`，默认 30 秒），确认了保留会话、超时或通信错误仍回收；期间新轮不能绕过排空屏障。无法确认回收完成时拒绝使用旧连接。provider 不声明可安全重试错误码，避免宿主整步重放导致重复认证、生成或工具调用。定位后由用户决定是否重试，不将错误掩盖为成功。
