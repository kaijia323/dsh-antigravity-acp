/**
 * 设置页模型列表的行合并（纯函数，无 IO）。
 *
 * 两个来源：ACP 会话观测到的目录（`adapter.listModels`）与官方 CLI 的只读清单
 * （`agy models`）。CLI 清单是**档位化**的原始行（`claude-opus-5-5-high`、
 * “Claude Opus 5.5 (High)”），直接拼进设置页会把同一模型的每个思考档位显示成
 * 独立条目——模型页只该列模型。所以 CLI 行先折叠成家族，再按 id 合并：ACP 观测
 * 优先（它有会话里真实的名称与描述），CLI 只补 ACP 还没观测到的家族。
 */
import { foldAgyModelFamilies } from '../runtime/agy-cli.js'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'

export interface CliModelRow {
  id: string
  name: string
}

/**
 * 合并模型行：ACP 目录原样保留，CLI 行折叠成家族后补齐缺失项。
 *
 * @param provider - provider id，用于补齐行。
 * @param acp - ACP 观测到的目录（已是家族 id）。
 * @param cli - 官方 CLI 的原始清单（可能带 `-low/-medium/-high/-xhigh` 后缀）。
 * @returns 去重后的行；同 id 时保留 ACP 侧的条目。
 */
export function mergeModelRows(
  provider: string,
  acp: readonly LlmModelInfo[],
  cli: readonly CliModelRow[],
): LlmModelInfo[] {
  // 已经观测到 ACP 会话声明的模型目录时，以当前账号真正可用的模型为准，
  // 不再把 CLI 清单里不可用的其它型号混进列表；仅在 ACP 目录为空（冷启动）时用 CLI 兜底。
  if (acp.length > 0) return [...acp]
  const byId = new Map<string, LlmModelInfo>()
  if (cli.length === 0) return []
  for (const row of foldAgyModelFamilies(cli).models) {
    if (byId.has(row.id)) continue
    byId.set(row.id, {
      provider,
      id: row.id,
      name: row.name,
      inputModalities: ['text'],
      ...(row.description === undefined ? {} : { description: row.description }),
    })
  }
  return [...byId.values()]
}
