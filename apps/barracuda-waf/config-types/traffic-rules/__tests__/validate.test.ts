import validate, { buildTrafficRuleBody, extractTrafficRuleSpecs, trafficRuleKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'traffic-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'traffic-rules',
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

const GOOD_FIELDS = {
  name: 'api-route',
  status: true,
  host_match: 'www.example.com',
  url_match: '/api/*',
  extended_match: '*',
  extended_match_sequence: 1,
  endpoints: ['1', '2'],
  servers: ['10'],
}

describe('Barracuda WAF Traffic Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: GOOD_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'rule1' } },
        { name: 'b', fields: { name: 'RULE1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects non-integer endpoint ids', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'rule1', endpoints: ['abc'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_id' && e.field.includes('endpoints'))).toBe(true)
  })

  it('extractTrafficRuleSpecs defaults host_match/url_match/extended_match', () => {
    const specs = extractTrafficRuleSpecs(makeCtx([{ name: 's', fields: { name: 'rule1' } }]).canvas)
    expect(specs[0].hostMatch).toBe('*')
    expect(specs[0].urlMatch).toBe('/*')
    expect(specs[0].extendedMatch).toBe('*')
    expect(specs[0].extendedMatchSequence).toBe(1)
    expect(specs[0].status).toBe(true)
  })

  it('trafficRuleKey lower-cases and trims', () => {
    expect(trafficRuleKey(' Rule1 ')).toBe('rule1')
  })

  it('buildTrafficRuleBody maps the spec onto the wire shape with numeric id arrays', () => {
    const specs = extractTrafficRuleSpecs(makeCtx([{ name: 's', fields: GOOD_FIELDS }]).canvas)
    expect(buildTrafficRuleBody(specs[0])).toEqual({
      name: 'api-route',
      status: true,
      endpoints: [1, 2],
      host_match: 'www.example.com',
      url_match: '/api/*',
      extended_match: '*',
      extended_match_sequence: 1,
      servers: [10],
    })
  })
})
