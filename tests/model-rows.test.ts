import { describe, expect, it } from 'vitest'
import { mergeModelRows } from '../src/adapter/model-rows.js'

const PROVIDER = 'antigravity-acp'

describe('设置页模型行合并', () => {
  it('CLI 的档位化行折叠成家族，不把思考档位当成独立模型', () => {
    const rows = mergeModelRows(PROVIDER, [], [
      { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
      { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
      { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      { id: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
      { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ])
    expect(rows.map((row) => row.id)).toEqual(['claude-opus-5-5', 'gemini-4-hydrogen'])
    // 名称也去掉档位后缀，模型页只剩模型名。
    expect(rows.map((row) => row.name)).toEqual(['Claude Opus 5.5', 'Gemini 4 Hydrogen'])
    expect(rows.every((row) => row.provider === PROVIDER)).toBe(true)
  })

  it('已观测到 ACP 目录时，只显示当前账号 ACP 声明的模型，不把 CLI 里不可用的其它型号混入', () => {
    const rows = mergeModelRows(PROVIDER, [
      { provider: PROVIDER, id: 'gemini-4-argon', name: 'Gemini 4 Argon', inputModalities: ['text'] },
    ], [
      { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' },
      { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
    ])
    expect(rows).toEqual([
      { provider: PROVIDER, id: 'gemini-4-argon', name: 'Gemini 4 Argon', inputModalities: ['text'] },
    ])
  })

  it('没有 CLI 清单时就是 ACP 目录本身', () => {
    const acp = [{ provider: PROVIDER, id: 'gemini-4-argon', name: 'Gemini 4 Argon', inputModalities: ['text'] as const }]
    expect(mergeModelRows(PROVIDER, acp, [])).toEqual([...acp])
  })
})
