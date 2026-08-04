import validate, { extractSecurityZoneSpecs, securityZoneKey, liveZoneTagNames } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'security-zones',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'security-zones',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Check Point Security Zones Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a zone with only a name', async () => {
    const result = await validate(makeCtx([{ name: 'Zone', fields: { name: 'dmz-zone' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { comments: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate zone names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'DMZ-Zone' } },
        { name: 'b', fields: { name: 'dmz-zone' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('extractSecurityZoneSpecs trims fields', () => {
    const specs = extractSecurityZoneSpecs(makeCtx([{ id: 'i1', name: 'e', fields: { name: '  zone-2  ' } }]).canvas)
    expect(specs[0].name).toBe('zone-2')
    expect(securityZoneKey('  Zone-2 ')).toBe('zone-2')
  })
})

describe('liveZoneTagNames', () => {
  it('flattens string and object-summary tags', () => {
    expect(liveZoneTagNames(['internal', { name: 'trusted' }])).toEqual(['internal', 'trusted'])
  })

  it('tolerates a missing tags array', () => {
    expect(liveZoneTagNames(undefined)).toEqual([])
  })
})
