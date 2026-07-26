import validate, {
  extractSecurityProfileGroupSpecs,
  buildSecurityProfileGroupFields,
  securityProfileGroupDriftDiffs,
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
    configTypeId: 'panorama-security-profile-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-security-profile-groups',
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

describe('Panorama Security Profile Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group referencing profiles', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'outbound', virus: 'default', url_filtering: 'strict' } }]))
    expect(result.valid).toBe(true)
  })

  it('warns when a group references no profiles', async () => {
    const result = await validate(makeCtx([{ name: 'g', fields: { name: 'empty' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_group')).toBe(true)
  })

  it('rejects duplicate group names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'grp', virus: 'default' } },
        { name: 'b', fields: { name: 'GRP', spyware: 'strict' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('maps field keys to REST element names as one-member lists', () => {
    const spec = extractSecurityProfileGroupSpecs(
      makeCtx([{ name: 'g', fields: { name: 'outbound', virus: 'default', url_filtering: 'strict', wildfire_analysis: 'default' } }]).canvas,
    )[0]
    expect(buildSecurityProfileGroupFields(spec)).toEqual({
      virus: { member: ['default'] },
      'url-filtering': { member: ['strict'] },
      'wildfire-analysis': { member: ['default'] },
    })
  })

  it('detects a changed and a removed profile reference', () => {
    const spec = extractSecurityProfileGroupSpecs(makeCtx([{ name: 'g', fields: { name: 'outbound', virus: 'default', spyware: 'strict' } }]).canvas)[0]
    const clean = securityProfileGroupDriftDiffs(spec, { '@name': 'outbound', virus: { member: ['default'] }, spyware: { member: ['strict'] } })
    expect(clean).toHaveLength(0)
    const drifted = securityProfileGroupDriftDiffs(spec, { '@name': 'outbound', virus: { member: ['relaxed'] } })
    expect(drifted.some((d) => d.field.endsWith('.virus'))).toBe(true)
    expect(drifted.some((d) => d.field.endsWith('.spyware'))).toBe(true)
  })
})
