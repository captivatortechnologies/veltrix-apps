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
    configTypeId: 'outbound-ports-v6',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'outbound-ports-v6',
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

describe('Splunk Cloud IPv6 Outbound Ports Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid IPv6 outbound port rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'rule1', fields: { port: 8089, subnets: ['2001:db8::/32', '2001:db9::/32'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing port', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { subnets: ['2001:db8::/32'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an out-of-range port', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { port: 70000, subnets: ['2001:db8::/32'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('accepts a numeric-string port', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { port: '443', subnets: ['2001:db8::/32'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate ports across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'r1', fields: { port: 8089, subnets: ['2001:db8::/32'] } },
        { name: 'r2', fields: { port: 8089, subnets: ['2001:db9::/32'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_port')).toBe(true)
  })

  it('rejects an empty subnet list', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { port: 8089 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects IPv4 destinations in this type', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { port: 8089, subnets: ['34.226.34.80/32'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects invalid CIDR notation', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { port: 8089, subnets: ['not-a-subnet', '2001:db8::zzzz/64'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_cidr')).toHaveLength(2)
  })

  it('warns (does not block) on ::/0 egress', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { port: 443, subnets: ['::/0'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'open_egress')).toBe(true)
  })

  it('warns on very broad destination ranges', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { port: 443, subnets: ['2001:db8::/16'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'broad_egress')).toBe(true)
  })

  it('warns on duplicate destination subnets', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { port: 8089, subnets: ['2001:db8::/32', '2001:db8::/32'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'duplicate_subnet')).toBe(true)
  })

  it('accepts subnets as a comma-separated string', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { port: 8089, subnets: '2001:db8::/32, 2001:db9::/32' } }]),
    )
    expect(result.valid).toBe(true)
  })
})
