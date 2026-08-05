import validate, { extractSonarQuerySpecs, sonarQueryKey, parseFilters } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-sonar-queries',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-sonar-queries',
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

describe('InsightVM Sonar Queries Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid Sonar query', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Query',
          fields: { name: 'External Web', criteria_json: '[{"field":"host-name","operator":"contains","value":"example.com"}]' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name and missing criteria', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('criteria_json'))).toBe(true)
  })

  it('rejects criteria that is not a JSON array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', criteria_json: '{"field":"x"}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_criteria')).toBe(true)
  })

  it('rejects an empty criteria array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', criteria_json: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_criteria')).toBe(true)
  })

  it('rejects a non-object filter entry', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', criteria_json: '["not-an-object"]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_criteria')).toBe(true)
  })

  it('rejects a duplicate Sonar query name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'External', criteria_json: '[{"field":"x","operator":"is","value":"y"}]' } },
        { name: 'b', fields: { name: 'external', criteria_json: '[{"field":"x","operator":"is","value":"z"}]' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_sonar_query')).toBe(true)
  })

  it('extract + helpers behave', () => {
    expect(parseFilters('  ').error).toBe('is required')
    expect(parseFilters('[{"field":"a","operator":"is","value":"b"}]').value).toEqual([{ field: 'a', operator: 'is', value: 'b' }])
    const specs = extractSonarQuerySpecs(
      makeCtx([{ name: 's', fields: { name: '  External Web  ', criteria_json: '[{"field":"a"}]' } }]).canvas,
    )
    expect(specs[0].name).toBe('External Web')
    expect(sonarQueryKey(specs[0])).toBe('external web')
  })
})
