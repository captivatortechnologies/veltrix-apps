import validate, { defaultDatafeedId, extractJobSpecs, parseJsonObject, splitList } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'ml-jobs',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'ml-jobs',
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

const ANALYSIS_CONFIG = '{"bucket_span":"15m","detectors":[{"function":"high_count"}]}'
const DATA_DESCRIPTION = '{"time_field":"@timestamp"}'

describe('Elastic Security ML Jobs Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal job', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Job',
          fields: {
            jobId: 'suspicious-login-rate',
            analysisConfigJson: ANALYSIS_CONFIG,
            dataDescriptionJson: DATA_DESCRIPTION,
            datafeedIndices: ['logs-*'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing jobId', async () => {
    const result = await validate(
      makeCtx([{ name: 'j1', fields: { analysisConfigJson: ANALYSIS_CONFIG, dataDescriptionJson: DATA_DESCRIPTION, datafeedIndices: ['a'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('jobId'))).toBe(true)
  })

  it('rejects missing analysisConfigJson / dataDescriptionJson', async () => {
    const result = await validate(makeCtx([{ name: 'j1', fields: { jobId: 'j1', datafeedIndices: ['a'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('analysisConfigJson'))).toBe(true)
    expect(result.errors.some((e) => e.field.includes('dataDescriptionJson'))).toBe(true)
  })

  it('rejects invalid analysisConfigJson', async () => {
    const result = await validate(
      makeCtx([
        { name: 'j1', fields: { jobId: 'j1', analysisConfigJson: 'not json', dataDescriptionJson: DATA_DESCRIPTION, datafeedIndices: ['a'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_analysis_config')).toBe(true)
  })

  it('rejects no datafeed indices', async () => {
    const result = await validate(
      makeCtx([{ name: 'j1', fields: { jobId: 'j1', analysisConfigJson: ANALYSIS_CONFIG, dataDescriptionJson: DATA_DESCRIPTION } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('datafeedIndices'))).toBe(true)
  })

  it('rejects invalid jobAdvancedJson', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'j1',
          fields: {
            jobId: 'j1',
            analysisConfigJson: ANALYSIS_CONFIG,
            dataDescriptionJson: DATA_DESCRIPTION,
            datafeedIndices: ['a'],
            jobAdvancedJson: 'not json',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_job_advanced')).toBe(true)
  })

  it('rejects a duplicate job id', async () => {
    const base = { analysisConfigJson: ANALYSIS_CONFIG, dataDescriptionJson: DATA_DESCRIPTION, datafeedIndices: ['a'] }
    const result = await validate(
      makeCtx([
        { name: 'j1', fields: { ...base, jobId: 'dup' } },
        { name: 'j2', fields: { ...base, jobId: 'dup' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_job')).toBe(true)
  })
})

describe('extractJobSpecs', () => {
  it('defaults datafeedId to datafeed-<jobId> when blank', () => {
    const specs = extractJobSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'ml-jobs',
      items: [],
      sections: [{ name: 'sec1', fields: { jobId: 'j1' } }],
      snapshot: {},
    })
    expect(specs[0].datafeedId).toBe('datafeed-j1')
  })

  it('respects an explicit datafeedId', () => {
    const specs = extractJobSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'ml-jobs',
      items: [],
      sections: [{ name: 'sec1', fields: { jobId: 'j1', datafeedId: 'custom-feed' } }],
      snapshot: {},
    })
    expect(specs[0].datafeedId).toBe('custom-feed')
  })
})

describe('defaultDatafeedId / splitList / parseJsonObject', () => {
  it('defaultDatafeedId builds the Kibana ML UI convention', () => {
    expect(defaultDatafeedId('my-job')).toBe('datafeed-my-job')
  })
  it('splitList normalizes lists', () => {
    expect(splitList([' a ', '', 'b'])).toEqual(['a', 'b'])
  })
  it('parseJsonObject accepts objects only', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('[1]')).toBeNull()
  })
})
