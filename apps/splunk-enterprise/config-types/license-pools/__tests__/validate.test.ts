import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'license-pools',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test License Pool Canvas',
      toolType: 'splunk-enterprise',
      entityType: 'license-pools',
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

describe('Splunk License Pools Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified pool', async () => {
    const result = await validate(
      makeCtx([{
        name: 'sec1',
        fields: {
          name: 'prod-pool',
          stackId: 'Enterprise',
          quota: '500GB',
          peers: '*',
          description: 'Production indexers',
        },
      }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing pool name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { stackId: 'Enterprise', quota: 'MAX' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('rejects invalid pool name format', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'bad pool!', stackId: 'Enterprise', quota: 'MAX' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.endsWith('.name'))).toBe(true)
  })

  it('detects duplicate pool names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'dup-pool', stackId: 'Enterprise', quota: 'MAX' } },
        { name: 'sec2', fields: { name: 'dup-pool', stackId: 'Enterprise', quota: '100GB' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('rejects missing stack', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'pool-1', quota: 'MAX' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.stackId'))).toBe(true)
  })

  it('rejects an unknown stack', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'pool-1', stackId: 'NotAStack', quota: 'MAX' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_stack')).toBe(true)
  })

  it('rejects missing quota', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'pool-1', stackId: 'Enterprise' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.quota'))).toBe(true)
  })

  it('accepts MAX quota (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'pool-1', stackId: 'Enterprise', quota: 'max' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a malformed quota', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'pool-1', stackId: 'Enterprise', quota: '500 gigs' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.endsWith('.quota'))).toBe(true)
  })

  it('rejects a zero quota', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'pool-1', stackId: 'Enterprise', quota: '0GB' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'zero_quota')).toBe(true)
  })

  it('warns when two pools on the same stack both claim MAX', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'pool-1', stackId: 'Enterprise', quota: 'MAX' } },
        { name: 'sec2', fields: { name: 'pool-2', stackId: 'Enterprise', quota: 'MAX' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'duplicate_max_pool')).toBe(true)
  })

  it('rejects an invalid peer id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'pool-1', stackId: 'Enterprise', quota: 'MAX', peers: 'peer one!' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.endsWith('.peers'))).toBe(true)
  })

  it('warns when peers is left empty', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'pool-1', stackId: 'Enterprise', quota: 'MAX', peers: '' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_peers')).toBe(true)
  })

  it('accepts a comma-separated peer list', async () => {
    const result = await validate(
      makeCtx([{
        name: 'sec1',
        fields: { name: 'pool-1', stackId: 'Enterprise', quota: 'MAX', peers: 'B37C0F3A-1937, A22D1F0B-8842' },
      }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects non-boolean appendPeers', async () => {
    const result = await validate(
      makeCtx([{
        name: 'sec1',
        fields: { name: 'pool-1', stackId: 'Enterprise', quota: 'MAX', appendPeers: 'yes' },
      }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })
})
