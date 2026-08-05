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
    configTypeId: 'ip-allowlists-v6',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'ip-allowlists-v6',
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

describe('Splunk Cloud IPv6 Allow Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid IPv6 allow list configuration', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'IPv6 Allowlist',
          fields: { feature: 'search-api', subnets: ['2001:db8::/32', '2001:db8::ff00:42:8329/128'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts the exact subnets documented by terraform-provider-scp', async () => {
    const result = await validate(
      makeCtx([
        { name: 'hec', fields: { feature: 'hec', subnets: ['fe84:1ee:fe23:4637::/64', '2001:db8::ff00:42:8329/128'] } },
        { name: 's2s', fields: { feature: 's2s', subnets: ['2001:db8::ff00:42:8329/128'] } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing feature', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { subnets: ['2001:db8::/32'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects unsupported feature', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'kv-store', subnets: ['2001:db8::/32'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_feature')).toBe(true)
  })

  it('rejects duplicate features across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 'hec', subnets: ['2001:db8::/32'] } },
        { name: 'sec2', fields: { feature: 'hec', subnets: ['2001:db9::/32'] } },
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

  it('rejects IPv4 subnets in this type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'search-api', subnets: ['203.0.113.0/24'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects malformed IPv6 CIDR notation', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'search-api', subnets: ['not-a-subnet', '2001:db8::zzzz/64'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_cidr')).toHaveLength(2)
  })

  it('rejects an out-of-range prefix length', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'search-api', subnets: ['2001:db8::/129'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects ::/0', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { feature: 'hec', subnets: ['::/0'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'open_to_world')).toBe(true)
  })

  it('warns on very broad subnets', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { feature: 'hec', subnets: ['2001:db8::/16'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'broad_subnet')).toBe(true)
  })

  it('warns on duplicate subnets', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 'hec', subnets: ['2001:db8::/32', '2001:db8::/32'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'duplicate_subnet')).toBe(true)
  })

  it('warns about lockout when reconciling the acs feature', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 'acs', subnets: ['2001:db8::/32'], removeUndeclared: true } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'acs_lockout_risk')).toBe(true)
  })

  it('accepts subnets as a comma-separated string', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { feature: 's2s', subnets: '2001:db8::/32, 2001:db9::/32' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates multiple feature sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { feature: 'search-api', subnets: ['2001:db8::/32'] } },
        { name: 'sec2', fields: { feature: 'hec', subnets: ['2001:db9::/32'] } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
