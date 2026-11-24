# 上游行为断言台账

本文件记录**插件对官方 `agy acp` 行为的每一条断言**，以及它当前的证据等级。
背景：2026-11-18 的排查里发现，若干“设计依据”其实是推断而非实测（最典型的是把
429 归因于并发），而推断写进代码后会被当成事实继续引用。

## 证据等级

- ✅ **真机实测**：有日志、探针或真机运行记录；改动前必须重跑对应验证。
- 🟡 **仅单元测试**：假 agent / 假 fetch 覆盖。注意：假 agent 已于 2026-11-18 删除，
  这类断言现在**等于没有证据**。
- ⚪ **推断**：来自协议文档、社区实现或“看起来合理”，从未验证。

## 台账

| # | 断言 | 代码位置 | 等级 | 验证方式 |
|---|---|---|---|---|
| 1 | stdio 使用换行分隔 JSON-RPC | `protocol/agent-link.ts` | ✅ | 真机探针 2026-11-18 |
| 2 | `initialize` 接受空的 `clientCapabilities` | 同上 | ✅ | 真机探针 |
| 3 | `session/new` 需要 `cwd` 与 `mcpServers` | 同上 | ✅ | 真机探针 + ACP 日志 |
| 4 | `session/prompt` 的 `stopReason: end_turn` / `cancelled` | `adapter/prompt-turn.ts` | ✅ | 真机探针 |
| 5 | `stopReason: max_tokens` / `refusal` / `max_turn_requests` 存在 | 同上 | ⚪ | 只按协议文档写进“干净失败”白名单 |
| 6 | `session/resume` 可接回**已取消**的会话 | `adapter/antigravity-adapter.ts` | ✅ | 真机探针：cancel → resume → prompt end_turn |
| 7 | 取消确认前发新 prompt 会被拒绝 | 同上 | ✅ | 真机探针：`wait for it to finish` |
| 8 | `session/list` 存在并列出会话 | 同上（未启用） | ✅ | 集成用例「取消确认后同一会话可以继续…」 |
| 9 | `session/close` 之后会话仍可 `resume` 并继续对话 | `adapter/antigravity-adapter.ts` | ✅ | 集成用例「session/close 之后仍能 resume 并继续对话」（2026-11-18） |
| 10 | `thought_level` 是独立 configOption，值含 low/medium/high；随当前模型变化 | 同上 | ✅ | 集成用例「新会话声明 model / thought_level / mode 选项…」；`xhigh` 仅 Hydrogen 家族，由 CLI 目录并集补 |
| 11 | `_meta.antigravity.systemPrompt.append` 把 system 追加进 agent 提示 | 同上 | ✅ | 0.1.52 changelog 记录真机 1.5.10 |
| 12 | `enabledTools: []` 关闭 agent 内置工具 | 同上 | ✅ | ACP 日志：工具请求全部走 `mcp_dsh-tools_*` |
| 13 | `eagerMcpServers: ["dsh-tools"]` 预加载桥 | 同上 | ✅ | ACP 日志与 `mcp/dsh-tools` 目录 |
| 14 | `usage_update.size/used` 是当前上下文而非累计 | `adapter/prompt-turn.ts` | ✅ | 0.1.52：修复 360%/411% 的实测 |
| 15 | MCP 工具可在同一 prompt 内被调用、回填并继续生成 | `adapter/prompt-turn.ts`、`bridge/mcp-bridge.ts` | ✅ | 集成用例「MCP 工具：agent 调用工具并在同一 prompt 内拿到结果继续」：真机调用 `ping` 得到 `pong:hello`、`end_turn` |
| 16 | MCP 桥的 loopback + bearer token + 权限握手 | `bridge/mcp-bridge.ts` | ✅ | 2026-11-20 真机（1.5.13 `agy acp`，隔离 HOME）：权限请求按服务端生成名识别后回 `allow_once`，工具结果回填后续轮 `stop`；同日复现拒绝分支（旧解析器拒绝 → 上游取消 cascade → 回合只剩思考、插件报 `AGY_EMPTY_RESPONSE`） |
| 17 | `session/set_mode` 接受 agent 声明的 mode（default/accept-edits/auto/plan） | 同上 | ✅ | 集成用例「…档位与模式可设置」：`set_mode` 返回 `{}` |
| 18 | `set_config_option` 可能归一化模型 ID | 同上 | 🟡 | 假 agent |
| 19 | 额度：`loadCodeAssist` → `retrieveUserQuotaSummary` 的端点与字段；当前账号返回 2 个额度组（`Gemini Models`、`Claude and GPT models`），Argon 并入 `Gemini Models` | `runtime/quota.ts` | ✅ | 2026-11-24 真机（隔离账号 acc_1795102134232_2190af30，Google AI Pro，`agy` 1.5.15）：HTTP `retrieveUserQuotaSummary` 与 CLI `agy -p /usage --output-format json` 均只返回上述 2 组；HTTP `fetchAvailableModels` 交叉验证 `gemini-4-argon-{low,medium,high}` 的 `quotaInfo`（remainingFraction / resetTime）与其它 Gemini 模型逐字段一致，无独立 Argon bucket。2026-11-18 历史为 3 组 |
| 20 | OAuth：PKCE、loopback 回调、token 交换 | `accounts/oauth.ts` | ⚪ | 只有假 fetch；真 Google 未验证（文档已承认） |
| 21 | Windows 强制完整性（icacls 探测）影响会话建立 | `runtime/integrity.ts` | ⚪ | 从未在 Windows 实机跑过（文档已承认） |
| 22 | `agy -p /usage` / `/credits` 输出格式 | `runtime/agy-cli.ts` | ✅ | 本机实跑日志 |
| 23 | 同一会话的后续 prompt 保留上下文（插件据此只发增量） | `adapter/session-reuse.ts` | ✅ | 集成用例「第二次 prompt 记得第一次的暗号 ZEBRA-731」 |
| 24 | 同账号 5 路并发（含长回答）不触发 429 | 无（实验结论） | ✅ | 2026-11-18 两轮探针：5/5 成功、零 429 |
| 25 | `PromptResponse.usage` 是**本回合**内各次内部模型调用之和（非会话累计）；`totalTokens` = 本轮 Σ `usage_update.used` | `adapter/prompt-turn.ts` | ✅ | 2026-11-18 探针（4 轮）：单调用轮 total=used=8700/8779；3 次调用轮 total=27150=8925+9060+9165，而回合末上下文只有 9165；第 4 轮 total=9244 < 上一轮 27150（若为累计不可能） |
| 26 | agy 对 MCP 工具声明 `mcp_dsh-tools_<后缀>_<短名>`，并在声明里附加必填 `toolSummary`；调用进 MCP 前这两项被剥离 | `adapter/tool-args.ts` | ✅ | 2026-11-18：agy 会话库里的工具声明含 `{"required":["toolSummary"],…}` 与 `mcp_dsh-tools_5406866c_*`；DSH `session-6642c5ed` 的 584 次 `tool/call` 参数里没有 `toolSummary` |
| 27 | DSH `busyEnter: steer` 会把用户插话作为**真实 user 消息**追加在工具结果之后（不是宿主上下文） | `adapter/continuation-state.ts` | ✅ | 真机 2026-11-19 15:23 会话 `a25898d0`：seq 33 user/message（`source.kind=user`）紧跟工具结果；旧版同一形态会话 `d7bdbc39` 在此报 `AGY_SESSION_UNRECOVERABLE` |
| 28 | 官方 ACP `session/new` 在冷启动 / 多 worker 并发时可能超过 30 秒 | `adapter/antigravity-adapter.ts`（`sessionTimeoutMs`） | ✅ | 真机 2026-11-19 15:07 子代理报 `ACP 请求超时（30000ms）: session/new`；同机 15:23 以 120 秒上限成功建立 Gemini 子代理并返回 `OK` |
| 29 | 工具续轮中把文本附到最后一条工具结果，agent 会在同一 prompt 内看到并回应 | `adapter/antigravity-adapter.ts`（`tailDeliveryNote`） | ✅ | 真机 2026-11-19 15:23：steer「额外告诉我 6*7」→ 助手回复 `6 × 7 = 42`（该内容只出现在 steer 中） |
| 30 | 1.5.13 `agy acp`（Go）的 MCP 权限请求**不带** `_meta.is_mcp_tool_call`/`_meta.mcp`：`toolCall.name = "mcp_<server>_<tool>"`、`title = "Run mcp_<server>_<tool>"`（无问号）、`rawInput` 带服务端注入的 `toolSummary`，options 为 `allow_once`/`reject_once` | `adapter/permission-handoff.ts` | ✅ | 2026-11-20 真机探针（隔离 HOME 逐字段 dump）：`mcp_dsh-tools_echo_probe` / `Run mcp_dsh-tools_echo_probe`；修复前拒绝 → 上游取消、修复后 `allow_once` → 工具续轮；回归用例 `tests/real-tool-permission.test.ts` |

## 优先验证顺序（按“错了会怎样”排序）

1. **#15 工具续轮**：这是本插件的核心价值（工具回 DSH 执行）。现在零真机证据、零单测，
   错了表现为“工具调用后对话卡死或重复执行”。
2. **#9 `session/close` 后能否 resume**：取消/异常路径依赖它；如果 close 即销毁，
   取消后继续聊就必须改成重建。
3. **#17 `set_mode`**：未验证就先声明支持，配置后可能直接失败。
4. **#20 OAuth 真机**：换账号/新增账号是高频操作，假 fetch 不能证明 Google 端可达。
5. **#21 Windows 完整性**：只在 Windows 上出错，且表现为“会话永久挂起”。

## 怎么跑

```bash
AGY_REAL_ACP=1 npx vitest run tests/integration-real-agent.test.ts   # 全部真机断言
AGY_REAL_ACP=1 npx vitest run tests/real-tool-permission.test.ts    # MCP 权限握手 → 工具续轮
```

用例与断言的对应关系写在用例名里（上表“验证方式”列）；新增断言时同时补用例，
否则它只能停在 ⚪。

## 无法在当前环境验证的

| 断言 | 原因 |
|---|---|
| #5 `max_tokens` / `refusal` / `max_turn_requests` 等 stopReason | 无法稳定构造；代码里只当作“干净失败”白名单，标 ⚪ |
| #18 `set_config_option` 归一化模型 ID | 需要 agent 返回不同 ID 的样本，未遇到 |
| #20 OAuth 真机 | 需要真实 Google 授权，当前只用假 fetch |
| #21 Windows 强制完整性 | 需要 Windows 实机 |

## 约定

- 新增对上游行为的判断时，必须在本表登记并写明证据等级；没有验证的写 ⚪，
  **不得在注释或文档里写成“实测”**。
- 修改任何 ✅ 项所对应的代码路径前，先重跑对应真机探针。
