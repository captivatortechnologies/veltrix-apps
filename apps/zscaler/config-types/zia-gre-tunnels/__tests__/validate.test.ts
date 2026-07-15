import validate, { extractGreTunnelSpecs, parseGreObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-gre-tunnels',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-gre-tunnels',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('ZIA GRE Tunnels Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid GRE tunnel', async () => {
    const result = await validate(
      makeCtx([{ name: 'GRE Tunnel', fields: { source_ip: '203.0.113.10', comment: 'HQ egress' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a GRE tunnel with an advanced gre_json object', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'GRE Tunnel',
          fields: {
            source_ip: '203.0.113.10',
            gre_json: '{ "primaryDestVip": { "id": 12345 }, "withinCountry": true }',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing source IP', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { comment: 'no source ip' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('source_ip'))).toBe(true)
  })

  it('rejects duplicate source IPs (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { source_ip: '2001:DB8::1' } },
        { name: 'b', fields: { source_ip: '2001:db8::1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_gre_tunnel')).toBe(true)
  })

  it('rejects a gre_json that is not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { source_ip: '203.0.113.10', gre_json: '{ not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a gre_json that parses to an array (must be an object)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { source_ip: '203.0.113.10', gre_json: '[1, 2, 3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('parseGreObject returns an empty object for a blank value', () => {
    const parsed = parseGreObject('   ')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual({})
  })

  it('extractGreTunnelSpecs trims and drops blank comments', () => {
    const specs = extractGreTunnelSpecs(
      makeCtx([{ name: 'GRE Tunnel', fields: { source_ip: '  203.0.113.10  ', comment: '   ' } }]).canvas,
    )
    expect(specs[0].sourceIp).toBe('203.0.113.10')
    expect(specs[0].comment).toBeUndefined()
  })
})
