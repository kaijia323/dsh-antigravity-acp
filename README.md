# dsh-antigravity-acp

[![Publish package](https://github.com/AlaIchhe/dsh-antigravity-acp/actions/workflows/publish.yml/badge.svg)](https://github.com/AlaIchhe/dsh-antigravity-acp/actions/workflows/publish.yml)

在 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 里接入 Google 官方 **Antigravity ACP agent**：
用 DSH 的界面选模型、发任务，工具调用仍由 DSH 审批和执行。

> 基于 [KouzakiUmi/dsh-antigravity-acp](https://github.com/KouzakiUmi/dsh-antigravity-acp)（MIT）的独立分支，
> 2026-11-17 起由 `AlaIchhe` 维护。上游原文见 [README.upstream.md](./README.upstream.md)；
>
> **本 fork（kaijia323/dsh-antigravity-acp）**：2026-11-19 起在 AlaIchhe fork 基础上自行维护，修复 DSH `busyEnter: steer` 插话导致会话不可恢复、续轮通知未投递、子代理 `session/new` 30 秒超时等问题（详见 [docs/changelog.md](./docs/changelog.md)）。安装用本仓库构建的 tarball（`npm run build && npm pack`）或钉 commit 的 git spec；
> 原作者如认为本分支不妥，提 [issue](https://github.com/AlaIchhe/dsh-antigravity-acp/issues) 即可，我会归档该仓库。

## 功能

- **官方 agent，不是转发 API**：走 ACP 协议驱动官方 `agy` 二进制，账号、额度、模型目录都来自官方
- **工具留在 DSH**：agent 的工具调用经私有 MCP 桥回到 DSH，由 DSH 校验、审批、执行
- **模型选择器直连**：Gemini 4 Argon / Hydrogen、Claude Opus 5.5、Sonnet 5.5 等家族一行；思考强度由 agent 声明，在 DSH 的思考强度菜单里选后写入官方 `thought_level`
- **多账号**：设置页里直接浏览器登录多个 Antigravity 账号，各自隔离 HOME；一键切换当前账号，额度按账号查看
- **额度可见**：按额度组显示窗口、剩余百分比与重置时间

## 安装

```bash
# 从 GitHub 安装
dsh plugin --profile <profile> add github:AlaIchhe/dsh-antigravity-acp
# 或从 npm 安装（包名与上游不同，见 docs/reference.md）
dsh plugin --profile <profile> add dsh-bundle-antigravity-acp
```

安装后重载 DSH 服务，在「设置 → Antigravity ACP」里点 **连接 / 登录 ACP** 完成授权。

## 使用

1. **登录**：设置页 →「账号」→「添加账号」，在浏览器里完成 Google 授权即可；也可以直接使用本机官方 CLI 的登录态（系统账号）。多账号之间互不覆盖，点「使用此账号」切换当前账号。
2. **选模型**：对话里打开模型选择器，选 `Antigravity (ACP)` 下的模型家族。
3. **调强度**：思考强度由官方 agent 声明（例如 Hydrogen 多一档 Extra），在 DSH 的思考强度菜单里选即可；插件把选择写入官方 `thought_level` 配置项，不再靠模型 ID 后缀。
4. **看额度**：每个账号卡片里点「拉取额度」，或直接看输入框旁的额度药丸（跟随当前账号）。

配置项、边界与排障见 [docs/reference.md](docs/reference.md) 与 [docs/configuration.md](docs/configuration.md)。

## 本分支的改动

只修了两处上游行为问题，其余与上游一致：

| 问题 | 处理 |
|---|---|
| 官方 1.5.x 给 Hydrogen 加了 `-xhigh` 档，上游正则不认，被折叠成独立家族 | 识别 `xhigh` 用于折叠旧目录；档位改由 agent 的 `thought_level` 选项声明后，`xhigh` 按 agent 的真实选项进入菜单 |
| 上下文占用锚点缺失，投影只增不减，一直显示 100% | 用 `usage_update.used` 作为回合用量样本兜底 |

详见 [CHANGELOG](docs/changelog.md)。

## 开发

```bash
npm ci
npx tsc --noEmit     # 类型检查
npx vitest run       # 47 个文件 / 846 项测试
```

## 许可

MIT，与上游一致。版权归 `dsh-bundle-antigravity-acp contributors`；本分支的修改同样以 MIT 发布。
