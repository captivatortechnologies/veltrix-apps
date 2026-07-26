import validate, {
  extractWildfireAnalysisSpecs,
  buildWildfireAnalysisFields,
  wildfireAnalysisDriftDiffs,
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
    configTypeId: 'panorama-wildfire-analysis-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-wildfire-analysis-profiles',
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

describe('Panorama WildFire Analysis Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a forward-all profile', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { name: 'wf', direction: 'both', analysis: 'public-cloud' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported direction and analysis location', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { name: 'wf', direction: 'sideways', analysis: 'moon' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_direction')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_analysis')).toBe(true)
  })

  it('defaults application/file-type to any and builds the single rule', () => {
    const spec = extractWildfireAnalysisSpecs(makeCtx([{ name: 'w', fields: { name: 'wf' } }]).canvas)[0]
    expect(buildWildfireAnalysisFields(spec)).toEqual({
      rules: {
        entry: [
          { '@name': 'forward-all', application: { member: ['any'] }, 'file-type': { member: ['any'] }, direction: 'both', analysis: 'public-cloud' },
        ],
      },
    })
  })

  it('detects a missing rule and a changed analysis location', () => {
    const spec = extractWildfireAnalysisSpecs(makeCtx([{ name: 'w', fields: { name: 'wf' } }]).canvas)[0]
    const clean = wildfireAnalysisDriftDiffs(spec, {
      '@name': 'wf',
      rules: { entry: { '@name': 'forward-all', application: { member: ['any'] }, 'file-type': { member: ['any'] }, direction: 'both', analysis: 'public-cloud' } },
    })
    expect(clean).toHaveLength(0)
    const changed = wildfireAnalysisDriftDiffs(spec, {
      '@name': 'wf',
      rules: { entry: [{ '@name': 'forward-all', application: { member: ['any'] }, 'file-type': { member: ['any'] }, direction: 'both', analysis: 'private-cloud' }] },
    })
    expect(changed.some((d) => d.field.endsWith('.analysis'))).toBe(true)
    const missing = wildfireAnalysisDriftDiffs(spec, { '@name': 'wf', rules: { entry: [] } })
    expect(missing.some((d) => d.severity === 'critical')).toBe(true)
  })
})
