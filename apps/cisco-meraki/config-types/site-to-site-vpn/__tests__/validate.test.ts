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
    configTypeId: 'site-to-site-vpn',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'site-to-site-vpn',
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

describe('site-to-site-vpn validation', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('accepts a valid network and JSON object', async () => {
    const result = await validate(ctx('L_123', '{"mode":"none","hubs":[],"subnets":[]}'))
    expect(result.valid).toBe(true)
  })

  it('rejects malformed JSON', async () => {
    const result = await validate(ctx('L_123', '{'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SETTINGS')).toBe(true)
  })

  it('accepts every documented mode', async () => {
    for (const mode of ['none', 'spoke', 'hub']) {
      const result = await validate(ctx('L_123', JSON.stringify({ mode })))
      expect(result.valid).toBe(true)
    }
  })

  it('rejects an unsupported mode', async () => {
    const result = await validate(ctx('L_123', '{"mode":"gateway"}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_MODE')).toBe(true)
  })

  it('accepts a spoke configuration with hubs and subnets', async () => {
    const result = await validate(
      ctx('L_123', '{"mode":"spoke","hubs":[{"hubId":"N_4901849","useDefaultRoute":true}],"subnets":[{"localSubnet":"192.168.1.0/24","useVpn":true}]}'),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a network id with illegal characters', async () => {
    const result = await validate(ctx('bad id!', '{}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NETWORK_ID')).toBe(true)
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
