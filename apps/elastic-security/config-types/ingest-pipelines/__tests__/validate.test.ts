import validate, {
  extractPipelineSpecs,
  isIntegrationManagedId,
  isManagedPipeline,
  isProtectedPipelineId,
  parseJsonArray,
  parseJsonObject,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'ingest-pipelines',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'ingest-pipelines',
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

describe('Elastic Security Ingest Pipelines Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal pipeline', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Pipeline',
          fields: { id: 'logs-app-enrich', processorsJson: '[{"set":{"field":"x","value":"y"}}]' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing id', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { processorsJson: '[{"set":{"field":"x","value":"y"}}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('id'))).toBe(true)
  })

  it('rejects a dot-prefixed id', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { id: '.internal', processorsJson: '[{"set":{"field":"x","value":"y"}}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_pipeline')).toBe(true)
  })

  it('warns on an "@" id (integration-managed convention)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'p1', fields: { id: 'logs-nginx.access@custom', processorsJson: '[{"set":{"field":"x","value":"y"}}]' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'integration_managed')).toBe(true)
  })

  it('rejects missing processors', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { id: 'p1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('processorsJson'))).toBe(true)
  })

  it('rejects invalid processorsJson', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { id: 'p1', processorsJson: '{"not":"array"}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_processors')).toBe(true)
  })

  it('rejects invalid onFailureJson', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p1',
          fields: { id: 'p1', processorsJson: '[{"set":{"field":"x","value":"y"}}]', onFailureJson: 'not json' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_on_failure')).toBe(true)
  })

  it('rejects a duplicate pipeline id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'p1', fields: { id: 'dup', processorsJson: '[]' } },
        { name: 'p2', fields: { id: 'dup', processorsJson: '[]' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_pipeline')).toBe(true)
  })
})

describe('extractPipelineSpecs', () => {
  it('trims fields and reads the numeric version', () => {
    const specs = extractPipelineSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'ingest-pipelines',
      items: [],
      sections: [{ name: 'sec1', fields: { id: '  p1  ', processorsJson: '[]', version: 3 } }],
      snapshot: {},
    })
    expect(specs[0].id).toBe('p1')
    expect(specs[0].version).toBe(3)
  })
})

describe('isProtectedPipelineId / isIntegrationManagedId', () => {
  it('flags dot-prefixed ids as protected', () => {
    expect(isProtectedPipelineId('.fleet_globals-1')).toBe(true)
    expect(isProtectedPipelineId('my-pipeline')).toBe(false)
  })
  it('flags "@"-containing ids as integration-managed', () => {
    expect(isIntegrationManagedId('logs-nginx.access@custom')).toBe(true)
    expect(isIntegrationManagedId('my-pipeline')).toBe(false)
  })
})

describe('parseJsonArray / parseJsonObject', () => {
  it('parseJsonArray accepts arrays only', () => {
    expect(parseJsonArray('[1,2]')).toEqual([1, 2])
    expect(parseJsonArray('{"a":1}')).toBeNull()
    expect(parseJsonArray('not json')).toBeNull()
  })
  it('parseJsonObject accepts objects only', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('[1,2]')).toBeNull()
  })
})

describe('isManagedPipeline', () => {
  it('is true when _meta.managed is true', () => {
    expect(isManagedPipeline({ _meta: { managed: true } })).toBe(true)
  })
  it('is false otherwise', () => {
    expect(isManagedPipeline({})).toBe(false)
    expect(isManagedPipeline({ _meta: { managed: false } })).toBe(false)
  })
})
