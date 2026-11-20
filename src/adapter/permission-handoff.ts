/**
 * 识别官方 ACP 权限提示中的私有 MCP 路由。元数据不是独立身份证明：
 * 调用方必须同时通过 session/new 禁用 AGY 内置工具和 ACP fs/terminal 能力。
 * 此处只允许进入私有桥，最终参数校验、审批、沙箱与执行仍由 DSH 负责。
 *
 * 两代官方实现的请求形状（均为服务端按实际待执行工具生成，不是模型正文）：
 * - 1.4.0 / 1.5.0 server（Python）：`toolCall._meta.is_mcp_tool_call=true` +
 *   `_meta.mcp={server,tool}`；eager 工具无元数据时标题为 `Run <tool>?`。
 * - 1.5.13 `agy acp`（Go）：没有元数据，程序化名称 `mcp_<server>_<tool>`、
 *   标题 `Run mcp_<server>_<tool>`（无问号），rawInput 即工具参数。
 *
 * 只按服务端生成的程序化名称 / 标题与**当前会话已公布的目录**做精确匹配；
 * 不从 rawInput 里的 ServerName / ToolName 等模型可控字段反推路由。
 */
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 1.5.13 起官方对 MCP 工具的程序化命名前缀：`mcp_<server>_`。 */
function mcpProgrammaticPrefix(serverName: string): string {
  return `mcp_${serverName}_`
}

/**
 * 1.5.13 实测形如 `mcp_<server>_<tool>`；历史声明里也出现过
 * `mcp_<server>_<短哈希>_<tool>` 的中间段（claims #26）。两种都接受，
 * 中间段不做解释，只用于精确锚定到本会话已公布的工具名。
 */
function matchesProgrammaticName(value: string, serverName: string, toolName: string): boolean {
  const prefix = mcpProgrammaticPrefix(serverName)
  if (!value.startsWith(prefix)) return false
  const rest = value.slice(prefix.length)
  return rest === toolName || rest.endsWith(`_${toolName}`)
}

/**
 * 从服务端生成字段（程序化名称 / 标题）里还原私有桥工具。
 *
 * 名称只接受带 `mcp_` 前缀的全名（1.5.13 实测形状）；标题额外兼容 1.4.0 的
 * `Run <tool>?` / `Run <server>_<tool>?`（标题由 server 按实际工具生成）。
 * 裸工具名只允许来自标题，不允许来自 name，避免把原生同名工具当成桥路由。
 */
function matchServerGeneratedTool(
  request: RequestPermissionRequest,
  context: { serverName: string; tools: readonly ToolSchema[] },
): ToolSchema | undefined {
  const call = request.toolCall
  const names = typeof call.name === 'string' ? [call.name] : []
  // 只认 server 生成的 "Run ..." 标题；普通标题不参与路由，避免把任意展示
  // 文本或模型可控文本当成工具身份（1.4.0 eager 与 1.5.13 均用 Run 前缀）。
  const title = typeof call.title === 'string' && call.title.startsWith('Run ')
    ? call.title.slice('Run '.length)
    : undefined
  const titles = title === undefined ? [] : [title, title.endsWith('?') ? title.slice(0, -1) : title]
  const known = (value: string): boolean =>
    context.tools.some((tool) => matchesProgrammaticName(value, context.serverName, tool.name))
  // 出现指向别的 server 的 mcp_ 身份（名称或标题）直接拒绝，即使另一个字段
  // 恰好命中本会话目录——两个服务端生成字段互相矛盾时不做猜测。
  for (const value of [...names, ...titles]) {
    if (value.startsWith('mcp_') && !known(value)) return undefined
  }
  const hits = new Set<ToolSchema>()
  for (const tool of context.tools) {
    const legacy = `${context.serverName}_${tool.name}`
    if (names.some((value) => matchesProgrammaticName(value, context.serverName, tool.name))) hits.add(tool)
    if (titles.some((value) => matchesProgrammaticName(value, context.serverName, tool.name)
      || value === legacy || value === tool.name)) hits.add(tool)
  }
  // 身份字段必须唯一指向一个已公布工具，否则不转交。
  return hits.size === 1 ? [...hits][0] : undefined
}

export function parsePermissionHandoff(
  request: RequestPermissionRequest,
  context: { sessionId: string; serverName: string; tools: readonly ToolSchema[] },
): { name: string; arguments: string } | undefined {
  if (request.sessionId !== context.sessionId || !request.toolCall.toolCallId) return undefined
  const meta = record(request.toolCall._meta)
  const mcp = record(meta?.mcp)
  const input = record(request.toolCall.rawInput) ?? {}
  const wrappedMcp = meta?.is_mcp_tool_call === true

  if (wrappedMcp) {
    const tool = mcp?.server === context.serverName ? context.tools.find((item) => item.name === mcp?.tool) : undefined
    if (!tool) return undefined
    // 明确的原生名称仍拒绝；kind 只是展示分类，不决定是否属于私有桥。
    const name = request.toolCall.name
    if (name != null && name !== 'call_mcp_tool' && name !== tool.name) return undefined
    // 权限提示里的参数只供诊断，不用于执行，不应因包装差异阻断已识别的桥路由。
    // 实际参数来自后续 tools/call，由桥转交 DSH 校验和审批。
    const properties = record(record(tool.parameters)?.properties)
    const args = properties && Object.hasOwn(properties, 'arguments')
      ? input
      : record(input.arguments) ?? input
    return { name: tool.name, arguments: JSON.stringify(args) }
  }

  // 1.5.13（无元数据）与 1.4.0 eager 形式：只认同目录里工具的精确名称/标题。
  const tool = matchServerGeneratedTool(request, context)
  if (!tool) return undefined
  const name = request.toolCall.name
  if (name != null && name !== 'call_mcp_tool' && name !== tool.name
    && !matchesProgrammaticName(name, context.serverName, tool.name)) return undefined
  // 参数同样只作诊断；1.5.13 的 rawInput 就是工具参数本体（含 server 注入的
  // toolSummary 等展示字段，不影响后续 tools/call 的真实参数）。
  return { name: tool.name, arguments: JSON.stringify(input) }
}
