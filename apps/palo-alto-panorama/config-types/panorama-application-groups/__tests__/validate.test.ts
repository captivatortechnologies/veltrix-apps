import validate, {
  extractApplicationGroupSpecs,
  buildApplicationGroupFields,
  applicationGroupDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-application-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-application-groups',
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

describe('Panorama Application Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with members', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'web-apps', members: ['ssl', 'web-browsing'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a group with no members', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'web-apps' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('members'))).toBe(true)
  })

  it('rejects duplicate group names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'grp', members: ['ssl'] } },
        { name: 'b', fields: { name: 'GRP', members: ['dns'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds the members body and detects drift', () => {
    const spec = extractApplicationGroupSpecs(makeCtx([{ name: 'g', fields: { name: 'web-apps', members: ['ssl', 'web-browsing'] } }]).canvas)[0]
    expect(buildApplicationGroupFields(spec)).toEqual({ members: { member: ['ssl', 'web-browsing'] } })
    expect(applicationGroupDriftDiffs(spec, { '@name': 'web-apps', members: { member: ['web-browsing', 'ssl'] } })).toHaveLength(0)
    expect(applicationGroupDriftDiffs(spec, { '@name': 'web-apps', members: { member: ['ssl'] } }).length).toBeGreaterThan(0)
  })
})
