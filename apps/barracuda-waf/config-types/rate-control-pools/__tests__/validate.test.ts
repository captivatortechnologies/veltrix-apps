import validate, { buildRateControlPoolBody, extractRateControlPoolSpecs, rateControlPoolKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'rate-control-pools',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'rate-control-pools',
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
  name: 'login-endpoint',
  max_active_requests: 100,
  max_unconfigured_clients: 100,
  max_per_client_backlog: 32,
  preferred_clients_json: JSON.stringify([{ name: 'internal-net', ip_range: '10.0.0.0/8', weight: 100, enabled: true }]),
  urls_json: JSON.stringify([{ name: 'api-paths', url: '/api/*', host: '*', extended_match: '*', priority: 1 }]),
}

describe('Barracuda WAF Rate Control Pools Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete pool', async () => {
    const result = await validate(makeCtx([{ name: 'Pool', fields: GOOD_FIELDS }]))
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
        { name: 'a', fields: { name: 'pool1' } },
        { name: 'b', fields: { name: 'POOL1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a negative max_active_requests', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'pool1', max_active_requests: -1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_number' && e.field.includes('max_active_requests'))).toBe(true)
  })

  it('rejects malformed preferred_clients_json', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'pool1', preferred_clients_json: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('preferred_clients_json'))).toBe(true)
  })

  it('rejects a preferred_clients_json entry missing a name', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: {
            name: 'pool1',
            preferred_clients_json: JSON.stringify([{ ip_range: '10.0.0.0/8', weight: 100, enabled: true }]),
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'malformed_entry' && e.field.includes('preferred_clients_json'))).toBe(true)
  })

  it('rejects malformed urls_json', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'pool1', urls_json: '[1, 2,' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('urls_json'))).toBe(true)
  })

  it('rejects a urls_json entry with a wrong-typed priority', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { name: 'pool1', urls_json: JSON.stringify([{ name: 'x', url: '/*', priority: 'high' }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'malformed_entry' && e.field.includes('urls_json'))).toBe(true)
  })

  it('accepts well-formed preferred_clients_json and urls_json', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: GOOD_FIELDS }]))
    expect(result.valid).toBe(true)
  })

  it('extractRateControlPoolSpecs defaults the request-rate limits and nested arrays', () => {
    const specs = extractRateControlPoolSpecs(makeCtx([{ name: 's', fields: { name: 'pool1' } }]).canvas)
    expect(specs[0].maxActiveRequests).toBe(100)
    expect(specs[0].maxUnconfiguredClients).toBe(100)
    expect(specs[0].maxPerClientBacklog).toBe(32)
    expect(specs[0].preferredClients).toEqual([])
    expect(specs[0].urls).toEqual([])
  })

  it('rateControlPoolKey lower-cases and trims', () => {
    expect(rateControlPoolKey(' Pool1 ')).toBe('pool1')
  })

  it('buildRateControlPoolBody maps the spec onto the wire shape', () => {
    const specs = extractRateControlPoolSpecs(makeCtx([{ name: 's', fields: GOOD_FIELDS }]).canvas)
    expect(buildRateControlPoolBody(specs[0])).toEqual({
      name: 'login-endpoint',
      max_active_requests: 100,
      max_unconfigured_clients: 100,
      max_per_client_backlog: 32,
      preferred_clients: [{ name: 'internal-net', ip_range: '10.0.0.0/8', weight: 100, enabled: true }],
      urls: [{ name: 'api-paths', url: '/api/*', host: '*', extended_match: '*', priority: 1 }],
    })
  })
})
