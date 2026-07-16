import validate, { extractAddressGroupSpecs, buildAddressGroupFields, addressGroupDriftDiffs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-address-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-address-groups',
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

describe('Panorama Address Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a static group with members', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'web', group_type: 'static', members: ['a', 'b'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a static group with no members', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'web', group_type: 'static' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('members'))).toBe(true)
  })

  it('rejects a dynamic group with no filter', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'web', group_type: 'dynamic' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('dynamic_filter'))).toBe(true)
  })

  it('builds static and dynamic bodies and detects drift', () => {
    const staticSpec = extractAddressGroupSpecs(makeCtx([{ name: 'g', fields: { name: 'web', group_type: 'static', members: ['a', 'b'] } }]).canvas)[0]
    expect(buildAddressGroupFields(staticSpec)).toEqual({ static: { member: ['a', 'b'] } })
    expect(addressGroupDriftDiffs(staticSpec, { '@name': 'web', static: { member: ['b', 'a'] } })).toHaveLength(0)

    const dynSpec = extractAddressGroupSpecs(makeCtx([{ name: 'g', fields: { name: 'dyn', group_type: 'dynamic', dynamic_filter: "'web'" } }]).canvas)[0]
    expect(buildAddressGroupFields(dynSpec)).toEqual({ dynamic: { filter: "'web'" } })
    expect(addressGroupDriftDiffs(dynSpec, { '@name': 'dyn', dynamic: { filter: "'db'" } }).length).toBeGreaterThan(0)
  })
})
