import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'appliance-security-intrusion',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'appliance-security-intrusion',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const ctx = (network_id: string, settings: string) => makeCtx([{ name: 'item', fields: { network_id, settings } }])

describe('appliance-security-intrusion validation', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('accepts a valid network and JSON object', async () => {
    const result = await validate(ctx('L_123', '{"mode":"prevention","idsRulesets":"balanced","protectedNetworks":{"useDefault":true}}'))
    expect(result.valid).toBe(true)
  })

  it('rejects malformed JSON', async () => {
    const result = await validate(ctx('L_123', '{'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SETTINGS')).toBe(true)
  })

  it('requires a network id', async () => {
    const result = await validate(ctx('', '{"mode":"disabled"}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED')).toBe(true)
  })

  it('rejects an invalid network id', async () => {
    const result = await validate(ctx('bad id!', '{"mode":"disabled"}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NETWORK_ID')).toBe(true)
  })

  it('rejects an unsupported mode', async () => {
    const result = await validate(ctx('L_123', '{"mode":"paranoid"}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_MODE')).toBe(true)
  })

  it('rejects an unsupported idsRulesets value', async () => {
    const result = await validate(ctx('L_123', '{"idsRulesets":"paranoid"}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RULESET')).toBe(true)
  })

  it('requires includedCidr and excludedCidr when protectedNetworks.useDefault is false', async () => {
    const result = await validate(ctx('L_123', '{"protectedNetworks":{"useDefault":false}}'))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED').length).toBe(2)
  })

  it('accepts protectedNetworks.useDefault=false with both CIDR lists populated', async () => {
    const result = await validate(
      ctx('L_123', '{"protectedNetworks":{"useDefault":false,"includedCidr":["10.0.0.0/8"],"excludedCidr":["127.0.0.0/8"]}}'),
    )
    expect(result.valid).toBe(true)
  })

  it('does not require CIDR lists when useDefault is true', async () => {
    const result = await validate(ctx('L_123', '{"protectedNetworks":{"useDefault":true}}'))
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate network id declared across items', async () => {
    const items = [
      { name: 'a', fields: { network_id: 'L_123', settings: '{}' } },
      { name: 'b', fields: { network_id: 'L_123', settings: '{}' } },
    ]
    const result = await validate(makeCtx(items))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NETWORK_ID')).toBe(true)
  })
})
