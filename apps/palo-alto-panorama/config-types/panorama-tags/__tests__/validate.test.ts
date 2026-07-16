import validate, { extractTagSpecs, buildTagFields, tagDriftDiffs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-tags',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-tags',
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

describe('Panorama Tags Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid tag', async () => {
    const result = await validate(makeCtx([{ name: 'Tag', fields: { name: 'prod', color: 'color2' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { color: 'color1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unsupported color', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', color: 'color99' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('rejects a duplicate name case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Prod' } },
        { name: 'b', fields: { name: 'prod' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds fields and detects drift', () => {
    const spec = extractTagSpecs(makeCtx([{ name: 't', fields: { name: '  web  ', color: 'color3', comments: 'edge' } }]).canvas)[0]
    expect(spec.name).toBe('web')
    expect(buildTagFields(spec)).toEqual({ color: 'color3', comments: 'edge' })
    expect(tagDriftDiffs(spec, { '@name': 'web', color: 'color3', comments: 'edge' })).toHaveLength(0)
    expect(tagDriftDiffs(spec, { '@name': 'web', color: 'color4' }).length).toBeGreaterThan(0)
  })
})
