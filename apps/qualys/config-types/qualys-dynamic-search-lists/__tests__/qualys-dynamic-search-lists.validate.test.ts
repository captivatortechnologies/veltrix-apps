import validate, { extractDynamicListSpecs, dynamicListKey, readBool } from '../validate'
import { buildCreateParams, buildUpdateParams, parseDynamicListBlock, parseGlobalFlag } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const CRITERIA = '{"confirmed_severities":"4,5","categories":"CGI","patch_available":1}'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-dynamic-search-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-dynamic-search-lists',
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

describe('Qualys Dynamic Search Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid dynamic search list', async () => {
    const result = await validate(
      makeCtx([{ name: 'List', fields: { title: 'Critical Web', global: true, criteria_json: CRITERIA } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing title', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { criteria_json: CRITERIA } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('title'))).toBe(true)
  })

  it('requires criteria_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', criteria_json: '   ' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('criteria_json'))).toBe(true)
  })

  it('rejects malformed criteria_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', criteria_json: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a nested (non-flat) criteria_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { title: 'x', criteria_json: '{"a":{"b":1}}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an empty criteria object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', criteria_json: '{}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('criteria_json'))).toBe(true)
  })

  it('rejects duplicate titles case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { title: 'PCI', criteria_json: CRITERIA } },
        { name: 'b', fields: { title: 'pci', criteria_json: CRITERIA } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_dynamic_list')).toBe(true)
  })

  it('readBool coerces and dynamicListKey lowercases', () => {
    expect(readBool('1', false)).toBe(true)
    expect(readBool(undefined, true)).toBe(true)
    expect(dynamicListKey({ title: 'Critical Web' })).toBe(dynamicListKey({ title: 'critical web' }))
  })

  it('build params flatten criteria and encode global as 1/0', () => {
    const spec = extractDynamicListSpecs(
      makeCtx([{ name: 't', fields: { title: 'Critical Web', global: true, comments: 'c', criteria_json: CRITERIA } }])
        .canvas,
    )[0]

    const create = buildCreateParams(spec)
    expect(create.action).toBe('create')
    expect(create.title).toBe('Critical Web')
    expect(create.global).toBe(1)
    expect(create.comments).toBe('c')
    expect(create.confirmed_severities).toBe('4,5')
    expect(create.patch_available).toBe(1)

    const update = buildUpdateParams(spec, '381')
    expect(update.action).toBe('update')
    expect(update.id).toBe('381')
    expect(update.categories).toBe('CGI')
  })

  it('first-class fields win over a colliding criteria key', () => {
    const spec = extractDynamicListSpecs(
      makeCtx([{ name: 't', fields: { title: 'Real Title', criteria_json: '{"title":"bogus","cvss_base":7}' } }])
        .canvas,
    )[0]
    const create = buildCreateParams(spec)
    expect(create.title).toBe('Real Title')
    expect(create.cvss_base).toBe(7)
  })

  it('parseDynamicListBlock reads id/title/global/comments', () => {
    const block =
      '<ID>381</ID><TITLE>Critical Web</TITLE><GLOBAL>Yes</GLOBAL>' +
      '<CRITERIA><CONFIRMED_SEVERITIES>4,5</CONFIRMED_SEVERITIES></CRITERIA><COMMENTS>c</COMMENTS>'
    const l = parseDynamicListBlock(block)
    expect(l.id).toBe('381')
    expect(l.title).toBe('Critical Web')
    expect(l.global).toBe(true)
    expect(l.comments).toBe('c')
  })

  it('parseGlobalFlag accepts Yes/No and 1/0', () => {
    expect(parseGlobalFlag('Yes')).toBe(true)
    expect(parseGlobalFlag('No')).toBe(false)
    expect(parseGlobalFlag('1')).toBe(true)
    expect(parseGlobalFlag('0')).toBe(false)
  })
})
