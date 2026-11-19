import { isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { describe, expect, it } from 'vitest'
import { Config, LIVE_SETTING_KEYS, liveHostConfig } from '../src/settings.js'

describe('live settings schema and runtime references', () => {
  

  it('启动、并发等普通配置仍保持普通类型，默认开关和零值正确', () => {
    const config = liveHostConfig(Config({ cancelGraceMs: 0, idleRecycleMs: 0 }))
    expect(config.resumeSessions).toBe(true)
    expect(config.cliQuotaEnabled).toBe(false)
    expect(config.cancelGraceMs).toBe(0)
    expect(config.idleRecycleMs).toBe(0)
    expect(config.handshakeTimeoutMs).toBe(120000)
    expect(config.sessionTimeoutMs).toBe(120000)
    expect(config.promptTimeoutMs).toBe(1_800_000)
    expect(config.extraArgs).toEqual([])
    expect(config.modelOverrides).toEqual({})
  })

  it('模型设置缺省启用；档位不再是配置字段，手写配置里的 effort 被保留但不参与路由', () => {
    expect(Config({ modelOverrides: { 'gemini-3-pro': {} } }).modelOverrides.get()).toEqual({ 'gemini-3-pro': { enabled: true } })
    // 兼容旧配置文件：多出来的键不报错，也不会被静默改写成某个档位。
    const legacy = { modelOverrides: { 'gemini-3-pro': { effort: 'max' } } } as unknown as Parameters<typeof Config>[0]
    expect(() => Config(legacy)).not.toThrow()
  })
})
