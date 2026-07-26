import validate, { extractFeatureSpecs, featureKey, readFeature, MANAGED_FEATURES } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'proofpoint',
    customerId: 'cust-1',
    configTypeId: 'pp-org-features',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'proofpoint',
      entityType: 'pp-org-features',
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

describe('Proofpoint Organization Features Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates enabling URL Defense', async () => {
    const result = await validate(makeCtx([{ name: 'Feature', fields: { feature: 'url_defense', enabled: true } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates disabling Attachment Defense', async () => {
    const result = await validate(makeCtx([{ name: 'Feature', fields: { feature: 'attachment_defense', enabled: false } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing feature', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { enabled: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unsupported feature', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { feature: 'quantum_shield', enabled: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_feature')).toBe(true)
  })

  it('rejects the non-boolean instant_replay feature (out of the managed set)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { feature: 'instant_replay', enabled: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_feature')).toBe(true)
  })

  it('rejects the same feature declared twice (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { feature: 'dlp', enabled: true } },
        { name: 'b', fields: { feature: 'DLP', enabled: false } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_feature')).toBe(true)
  })

  it('extractFeatureSpecs lower-cases the feature and defaults enabled to true', () => {
    const specs = extractFeatureSpecs(makeCtx([{ name: 'f', fields: { feature: '  URL_Defense ' } }]).canvas)
    expect(specs[0].feature).toBe('url_defense')
    expect(specs[0].enabled).toBe(true)
    expect(featureKey('  DLP ')).toBe('dlp')
  })

  it('extractFeatureSpecs parses a string "false" enabled value', () => {
    const specs = extractFeatureSpecs(makeCtx([{ name: 'f', fields: { feature: 'anti_spoofing', enabled: 'false' } }]).canvas)
    expect(specs[0].enabled).toBe(false)
  })

  it('MANAGED_FEATURES covers URL Defense and both Attachment Defense features', () => {
    expect(MANAGED_FEATURES).toContain('url_defense')
    expect(MANAGED_FEATURES).toContain('attachment_defense')
    expect(MANAGED_FEATURES).toContain('attachment_defense_sandboxing')
    expect(MANAGED_FEATURES.includes('instant_replay' as never)).toBe(false)
  })

  it('readFeature reads booleans case-insensitively and returns null when absent', () => {
    const features = { url_defense: true, Attachment_Defense: false, dlp: 'true' }
    expect(readFeature(features, 'url_defense')).toBe(true)
    expect(readFeature(features, 'attachment_defense')).toBe(false)
    expect(readFeature(features, 'dlp')).toBe(true)
    expect(readFeature(features, 'email_archive')).toBeNull()
  })
})
