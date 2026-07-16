import validate, { extractAssetGroupSpecs, assetGroupKey, parseJsonObject } from '../validate'
import { buildBody } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-asset-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-asset-groups',
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

describe('InsightVM Asset Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid static asset group', async () => {
    const result = await validate(
      makeCtx([{ name: 'Group', fields: { name: 'DB Servers', description: 'prod db', type: 'static' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid dynamic asset group with search criteria', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Group',
          fields: {
            name: 'Web Servers',
            type: 'dynamic',
            search_criteria_json: '{"match":"all","filters":[{"field":"host-name","operator":"contains","value":"web"}]}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'static' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', type: 'nope' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires search_criteria_json when type is dynamic', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', type: 'dynamic' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('search_criteria_json'))).toBe(true)
  })

  it('rejects invalid search_criteria_json for a dynamic group (array)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x', type: 'dynamic', search_criteria_json: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'DB', type: 'static' } },
        { name: 'b', fields: { name: 'db', type: 'static' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_asset_group')).toBe(true)
  })

  it('extract + helpers behave and buildBody omits criteria for static', () => {
    expect(parseJsonObject('  ').error).toBeNull()
    expect(parseJsonObject('{"match":"all"}').value).toEqual({ match: 'all' })
    const specs = extractAssetGroupSpecs(
      makeCtx([{ name: 't', fields: { name: '  DB  ', description: ' desc ', type: 'static' } }]).canvas,
    )
    expect(specs[0].name).toBe('DB')
    expect(specs[0].description).toBe('desc')
    expect(assetGroupKey(specs[0])).toBe(assetGroupKey({ name: 'db' }))

    const staticBody = buildBody({ sectionName: 't', name: 'DB', description: 'desc', type: 'static', searchCriteriaJson: '{"a":1}' })
    expect(staticBody.searchCriteria).toBeUndefined()

    const dynamicBody = buildBody({ sectionName: 't', name: 'Web', description: '', type: 'dynamic', searchCriteriaJson: '{"match":"all"}' })
    expect(dynamicBody.searchCriteria).toEqual({ match: 'all' })
  })
})
