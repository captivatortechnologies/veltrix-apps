import validate, { buildNetworkRangeBody, extractNetworkRangeSpecs } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCanvas(items: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'cato-networks',
    entityType: 'network-ranges',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cato-networks',
    customerId: 'cust-1',
    configTypeId: 'network-ranges',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Network Ranges validate', () => {
  it('accepts an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(true)
  })

  it('validates a well-formed range', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'DMZ', ipRange: '10.0.0.1-10.0.0.10' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing ipRange', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'DMZ' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_IP_RANGE')).toBe(true)
  })

  it('rejects a malformed ipRange (missing dash)', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'DMZ', ipRange: '10.0.0.1 10.0.0.10' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_IP_RANGE_FORMAT')).toBe(true)
  })

  it('rejects an out-of-range octet', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'DMZ', ipRange: '10.0.0.1-10.0.0.999' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_IP_RANGE_OCTET')).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'i1', fields: { name: 'DMZ', ipRange: '10.0.0.1-10.0.0.10' } },
        { name: 'i2', fields: { name: 'dmz', ipRange: '10.0.0.1-10.0.0.10' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })
})

describe('buildNetworkRangeBody', () => {
  it('omits an empty description', () => {
    const specs = extractNetworkRangeSpecs(makeCanvas([{ name: 'i1', fields: { name: 'DMZ', ipRange: '10.0.0.1-10.0.0.10' } }]))
    const body = buildNetworkRangeBody(specs[0])
    expect(body).toEqual({ name: 'DMZ', description: undefined, ipRange: '10.0.0.1-10.0.0.10' })
  })
})
