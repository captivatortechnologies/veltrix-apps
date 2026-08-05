import validate, { extractIpReputationSpec, buildIpReputationBody } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'ip-reputation',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'ip-reputation',
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

describe('Barracuda WAF IP Reputation Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal configuration', async () => {
    const result = await validate(makeCtx([{ name: 'IP Reputation', fields: { enabled: true, block_tor_nodes: true } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects more than one declared item (singleton)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }, { name: 'b', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('rejects malformed exceptions JSON', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { exceptions_json: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an exception missing a valid IP', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { exceptions_json: JSON.stringify([{ allow: true, ip: 'not-an-ip', netmask: '255.255.255.255' }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('accepts a well-formed exception', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: { exceptions_json: JSON.stringify([{ allow: true, ip: '108.174.8.0', netmask: '255.255.255.0', comment: 'Office' }]) },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns on a malformed country code', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { blocked_countries: ['USA'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'country_format')).toBe(true)
  })

  it('extractIpReputationSpec defaults booleans to false and applyPolicyAt to Network Layer', () => {
    const spec = extractIpReputationSpec(makeCtx([{ name: 's', fields: {} }]).canvas)
    expect(spec.enabled).toBe(false)
    expect(spec.applyPolicyAt).toBe('Network Layer')
    expect(spec.blockedCountries).toEqual([])
    expect(spec.exceptions).toEqual([])
  })

  it('buildIpReputationBody maps the spec onto the wire shape', () => {
    const spec = extractIpReputationSpec(
      makeCtx([
        {
          name: 's',
          fields: {
            enabled: true,
            block_tor_nodes: true,
            blocked_countries: ['KP', 'CN'],
            exceptions_json: JSON.stringify([{ allow: false, ip: '1.2.3.4', netmask: '255.255.255.255', comment: 'blocked' }]),
          },
        },
      ]).canvas,
    )
    const body = buildIpReputationBody(spec)
    expect(body.enabled).toBe(true)
    expect(body.block_tor_nodes).toBe(true)
    expect(body.blocked_countries).toEqual(['KP', 'CN'])
    expect(body.exceptions).toEqual([{ allow: false, ip: '1.2.3.4', netmask: '255.255.255.255', comment: 'blocked' }])
  })
})
