import validate, { extractAssetTagSpecs, assetTagKey, isDynamicRule } from '../validate'
import { buildTagRequest, buildSearchRequest, parseTag, firstTagId, normalizeColor } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-asset-tags',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-asset-tags',
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

describe('Qualys Asset Tags Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a static tag (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Tag', fields: { name: 'Production', rule_type: 'STATIC' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a dynamic tag with rule text', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Tag', fields: { name: 'Windows', rule_type: 'NAME_CONTAINS', rule_text: 'windows', color: '#29B4C6', criticality_score: 4 } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { rule_type: 'STATIC' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported rule type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', rule_type: 'MAGIC' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('requires rule text for a dynamic rule type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', rule_type: 'OS_REGEX' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_text'))).toBe(true)
  })

  it('rejects an invalid color', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', color: 'blue' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('rejects a criticality score outside 1-5', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', criticality_score: 9 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_criticality')).toBe(true)
  })

  it('rejects duplicate names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Prod' } },
        { name: 'b', fields: { name: 'prod' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_tag')).toBe(true)
  })

  it('isDynamicRule treats STATIC/empty as static and assetTagKey lowercases', () => {
    expect(isDynamicRule('STATIC')).toBe(false)
    expect(isDynamicRule('')).toBe(false)
    expect(isDynamicRule('NAME_CONTAINS')).toBe(true)
    expect(assetTagKey({ name: 'Prod Web' })).toBe(assetTagKey({ name: 'prod web' }))
  })

  it('buildTagRequest omits rule for a static tag and includes it for a dynamic one', () => {
    const staticSpec = extractAssetTagSpecs(makeCtx([{ name: 't', fields: { name: 'Prod', rule_type: 'STATIC', color: '29b4c6' } }]).canvas)[0]
    const staticReq = buildTagRequest(staticSpec).ServiceRequest.data.Tag
    expect(staticReq.name).toBe('Prod')
    expect(staticReq.ruleType).toBeUndefined()
    expect(staticReq.ruleText).toBeUndefined()
    expect(staticReq.color).toBe('#29B4C6')

    const dynSpec = extractAssetTagSpecs(
      makeCtx([{ name: 't', fields: { name: 'Win', rule_type: 'NAME_CONTAINS', rule_text: 'windows', criticality_score: 3 } }]).canvas,
    )[0]
    const dynReq = buildTagRequest(dynSpec).ServiceRequest.data.Tag
    expect(dynReq.ruleType).toBe('NAME_CONTAINS')
    expect(dynReq.ruleText).toBe('windows')
    expect(dynReq.criticalityScore).toBe(3)
  })

  it('buildSearchRequest pages by id GREATER lastId', () => {
    const req = buildSearchRequest(42) as { ServiceRequest: { filters: { Criteria: Array<Record<string, unknown>> } } }
    const criterion = req.ServiceRequest.filters.Criteria[0]
    expect(criterion.field).toBe('id')
    expect(criterion.operator).toBe('GREATER')
    expect(criterion.value).toBe('42')
  })

  it('parseTag reads id/name/ruleType/ruleText and normalizeColor adds #', () => {
    const tag = parseTag({ id: 101, name: 'Windows', ruleType: 'name_contains', ruleText: 'windows', color: '#FFF000', criticalityScore: 4 })
    expect(tag.id).toBe('101')
    expect(tag.name).toBe('Windows')
    expect(tag.ruleType).toBe('NAME_CONTAINS')
    expect(tag.ruleText).toBe('windows')
    expect(normalizeColor('abcdef')).toBe('#ABCDEF')
  })

  it('firstTagId reads the created id from a ServiceResponse', () => {
    const res = { json: { ServiceResponse: { responseCode: 'SUCCESS', data: [{ Tag: { id: 777, name: 'X' } }] } } }
    expect(firstTagId(res)).toBe('777')
    expect(firstTagId({ json: { ServiceResponse: { data: [] } } })).toBeNull()
  })
})
