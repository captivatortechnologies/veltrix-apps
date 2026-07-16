import validate, { extractServiceGroupSpecs, buildServiceGroupFields, serviceGroupDriftDiffs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-service-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-service-groups',
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

describe('Panorama Service Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with members', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'web-svcs', members: ['https', 'http'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a group with no members', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'empty' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('members'))).toBe(true)
  })

  it('builds members body and detects drift', () => {
    const spec = extractServiceGroupSpecs(makeCtx([{ name: 'g', fields: { name: 'web-svcs', members: ['https', 'http'] } }]).canvas)[0]
    expect(buildServiceGroupFields(spec)).toEqual({ members: { member: ['https', 'http'] } })
    expect(serviceGroupDriftDiffs(spec, { '@name': 'web-svcs', members: { member: ['http', 'https'] } })).toHaveLength(0)
    expect(serviceGroupDriftDiffs(spec, { '@name': 'web-svcs', members: { member: ['https'] } }).length).toBeGreaterThan(0)
  })
})
