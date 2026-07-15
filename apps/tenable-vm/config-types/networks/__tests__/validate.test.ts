import validate, { extractNetworkSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'networks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'networks',
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

describe('Tenable Networks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid network (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Network', fields: { name: 'Corporate DMZ' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid network with a description and asset TTL', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Network',
          fields: { name: 'Lab', description: 'Isolated test range', assetsTtlDays: 90 },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects the reserved name "default"', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'default' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects the reserved name regardless of case', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Default' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects an asset TTL below the minimum of 14', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Lab', assetsTtlDays: 13 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ttl')).toBe(true)
  })

  it('rejects an asset TTL above the maximum of 365', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Lab', assetsTtlDays: 366 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ttl')).toBe(true)
  })

  it('rejects a non-integer asset TTL', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Lab', assetsTtlDays: 30.5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ttl')).toBe(true)
  })

  it('accepts the boundary asset TTL values 14 and 365', async () => {
    const low = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Low', assetsTtlDays: 14 } }]))
    const high = await validate(makeCtx([{ name: 'sec1', fields: { name: 'High', assetsTtlDays: 365 } }]))
    expect(low.valid).toBe(true)
    expect(high.valid).toBe(true)
  })

  it('rejects a duplicate network name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Corporate' } },
        { name: 'sec2', fields: { name: 'Corporate' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_network')).toBe(true)
  })

  it('allows two distinct network names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Corporate' } },
        { name: 'sec2', fields: { name: 'Guest' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractNetworkSpecs', () => {
  it('trims fields, drops empty optional values, and coerces the TTL', () => {
    const specs = extractNetworkSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'networks',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Corporate  ',
            description: '  ',
            assetsTtlDays: '90',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Corporate')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].assetsTtlDays).toBe(90)
  })

  it('leaves an unset TTL undefined', () => {
    const specs = extractNetworkSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'networks',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'Corporate' } }],
      snapshot: {},
    })
    expect(specs[0].assetsTtlDays).toBeUndefined()
  })
})
