import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'ip-allowlists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'ip-allowlists',
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Splunk Cloud IP Allow Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid allow list configuration', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'IP Allowlist',
          fields: { feature: 'search-api', subnets: ['203.0.113.0/24', '198.51.100.7/32'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing feature', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { subnets: ['203.0.113.0/24'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects unsupported feature', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'kv-store', subnets: ['203.0.113.0/24'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_feature')).toBe(true)
  })

  it('rejects duplicate features across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 'hec', subnets: ['203.0.113.0/24'] } },
        { name: 'sec2', fields: { feature: 'hec', subnets: ['198.51.100.0/24'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_feature')).toBe(true)
  })

  it('rejects empty subnet list', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { feature: 's2s' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid CIDR notation', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 'search-api', subnets: ['not-a-subnet', '10.0.0.1'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_cidr')).toHaveLength(2)
  })

  it('rejects out-of-range octets and prefixes', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 'search-api', subnets: ['300.0.0.0/24', '10.0.0.0/33'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_cidr')).toHaveLength(2)
  })

  it('rejects IPv6 subnets in this app version', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 'search-api', subnets: ['fe84:1ee:fe23:3333::/64'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects 0.0.0.0/0', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'hec', subnets: ['0.0.0.0/0'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'open_to_world')).toBe(true)
  })

  it('warns on very broad subnets', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'hec', subnets: ['10.0.0.0/7'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'broad_subnet')).toBe(true)
  })

  it('warns on duplicate subnets', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { feature: 'hec', subnets: ['203.0.113.0/24', '203.0.113.0/24'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'duplicate_subnet')).toBe(true)
  })

  it('rejects more than 200 subnets per feature', async () => {
    const subnets = Array.from({ length: 201 }, (_, i) => `10.${Math.floor(i / 250)}.${i % 250}.0/24`)
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'search-api', subnets } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'subnet_limit')).toBe(true)
  })

  it('warns about lockout when reconciling the acs feature', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { feature: 'acs', subnets: ['203.0.113.0/24'], removeUndeclared: true },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'acs_lockout_risk')).toBe(true)
  })

  it('accepts subnets as a comma-separated string', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 's2s', subnets: '203.0.113.0/24, 198.51.100.7/32' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates multiple feature sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 'search-api', subnets: ['203.0.113.0/24'] } },
        { name: 'sec2', fields: { feature: 'hec', subnets: ['198.51.100.0/24'] } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
