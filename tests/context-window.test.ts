import { describe, expect, it } from 'vitest'
import { fallbackContextWindow } from '../src/adapter/antigravity-adapter.js'

describe('上下文窗口兜底（切换模型时的压缩容量）', () => {
  it('未观测容量的模型按可配置默认值补齐', () => {
    expect(fallbackContextWindow('gemini-4-hydrogen', 1_048_576)).toBe(1_048_576)
    expect(fallbackContextWindow('gemini-4-argon', 1_048_576)).toBe(1_048_576)
    expect(fallbackContextWindow('gemini-3.8-flash', 1_048_576)).toBe(1_048_576)
  })
  it('Claude 家族封顶 200k，避免高估导致上游截断', () => {
    expect(fallbackContextWindow('claude-opus-5-5', 1_048_576)).toBe(200_000)
    expect(fallbackContextWindow('claude-sonnet-5-5', 400_000)).toBe(200_000)
    expect(fallbackContextWindow('claude-opus-5-5', 150_000)).toBe(150_000)
  })
  it('配置为 0 或非法值时恢复旧行为（不填容量）', () => {
    expect(fallbackContextWindow('gemini-4-hydrogen', 0)).toBeUndefined()
    expect(fallbackContextWindow('gemini-4-hydrogen', -1)).toBeUndefined()
    expect(fallbackContextWindow('gemini-4-hydrogen', Number.NaN)).toBeUndefined()
  })
})
