import validate, { extractSavedSearchSpecs, savedSearchKey } from '../validate'
import { buildSavedSearchBody } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-hunting-queries',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-hunting-queries',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      subscription_id: '11111111-1111-1111-1111-111111111111',
      resource_group: 'rg-soc',
      workspace_name: 'ws-sentinel',
      azure_cloud: 'commercial',
    },
    platform: stubPlatform,
  }
}

const validQuery = {
  saved_search_name: 'Failed sign-ins burst',
  category: 'Hunting Queries',
  query: 'SigninLogs | where ResultType != 0 | summarize count() by IPAddress',
  function_alias: '',
  function_parameters: '',
}

describe('Sentinel Hunting Queries Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete hunting query', async () => {
    const result = await validate(makeCtx([{ name: 'q', fields: { ...validQuery } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name and a query', async () => {
    const result = await validate(makeCtx([{ name: 'q', fields: { ...validQuery, saved_search_name: '', query: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.saved_search_name') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.query') && e.code === 'required')).toBe(true)
  })

  it('rejects function parameters without a function alias', async () => {
    const result = await validate(makeCtx([{ name: 'q', fields: { ...validQuery, function_parameters: 'a:int=1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'parameters_without_alias')).toBe(true)
  })

  it('rejects duplicate names that slug to the same id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validQuery, saved_search_name: 'Failed sign-ins burst' } },
        { name: 'b', fields: { ...validQuery, saved_search_name: 'Failed   Sign-Ins   Burst' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_saved_search')).toBe(true)
  })

  it('derives a deterministic savedSearchId and defaults the category', () => {
    const specs = extractSavedSearchSpecs(makeCtx([{ name: 'q', fields: { ...validQuery, category: '' } }]).canvas)
    expect(specs[0].savedSearchId).toBe('failed-sign-ins-burst')
    expect(specs[0].category).toBe('Hunting Queries')
    expect(savedSearchKey('Failed sign-ins burst')).toBe('failed-sign-ins-burst')
  })

  it('builds a create body without an etag and an update body with etag "*"', () => {
    const specs = extractSavedSearchSpecs(makeCtx([{ name: 'q', fields: { ...validQuery } }]).canvas)
    const createBody = buildSavedSearchBody(specs[0], false) as { etag?: string; properties: Record<string, unknown> }
    expect(createBody.etag).toBeUndefined()
    expect(createBody.properties.category).toBe('Hunting Queries')
    expect(createBody.properties.displayName).toBe('Failed sign-ins burst')
    expect(createBody.properties.version).toBe(2)
    const updateBody = buildSavedSearchBody(specs[0], true) as { etag?: string }
    expect(updateBody.etag).toBe('*')
  })

  it('includes functionAlias/functionParameters only when an alias is set', () => {
    const withFn = extractSavedSearchSpecs(
      makeCtx([{ name: 'q', fields: { ...validQuery, function_alias: 'FailedSignins', function_parameters: 'lookback:timespan=7d' } }]).canvas,
    )
    const body = buildSavedSearchBody(withFn[0], false) as { properties: Record<string, unknown> }
    expect(body.properties.functionAlias).toBe('FailedSignins')
    expect(body.properties.functionParameters).toBe('lookback:timespan=7d')

    const plain = extractSavedSearchSpecs(makeCtx([{ name: 'q', fields: { ...validQuery } }]).canvas)
    const plainBody = buildSavedSearchBody(plain[0], false) as { properties: Record<string, unknown> }
    expect(plainBody.properties.functionAlias).toBeUndefined()
  })
})
