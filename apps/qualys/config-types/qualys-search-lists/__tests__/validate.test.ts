import validate, { extractSearchListSpecs, searchListKey, parseQids, readBool } from '../validate'
import { buildCreateParams, buildUpdateParams, parseSearchListBlock } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-search-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-search-lists',
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

describe('Qualys Search Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid search list', async () => {
    const result = await validate(
      makeCtx([{ name: 'List', fields: { title: 'PCI QIDs', qids: '38173, 86476 105943', global: true } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing title', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { qids: '123' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('title'))).toBe(true)
  })

  it('requires at least one QID', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', qids: '   ' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('qids'))).toBe(true)
  })

  it('rejects non-numeric QIDs', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { title: 'x', qids: '123, abc, 456' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_qid')).toBe(true)
  })

  it('rejects duplicate titles case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { title: 'PCI', qids: '1' } },
        { name: 'b', fields: { title: 'pci', qids: '2' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_search_list')).toBe(true)
  })

  it('parseQids de-duplicates and readBool coerces', () => {
    expect(parseQids('1, 2 2\n3,3')).toEqual(['1', '2', '3'])
    expect(readBool('1', false)).toBe(true)
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
  })

  it('build params normalize qids and encode global as 1/0', () => {
    const spec = extractSearchListSpecs(
      makeCtx([{ name: 't', fields: { title: 'PCI', qids: '38173  86476, 38173', global: true, comments: 'c' } }]).canvas,
    )[0]
    expect(searchListKey(spec)).toBe(searchListKey({ title: 'pci' }))

    const create = buildCreateParams(spec)
    expect(create.action).toBe('create')
    expect(create.qids).toBe('38173,86476')
    expect(create.global).toBe(1)

    const update = buildUpdateParams(spec, '77')
    expect(update.action).toBe('update')
    expect(update.id).toBe('77')
    expect(update.qids).toBe('38173,86476')
  })

  it('parseSearchListBlock reads id/title/global/qids', () => {
    const block =
      '<ID>77</ID><TITLE>PCI QIDs</TITLE><GLOBAL>1</GLOBAL>' +
      '<QIDS><QID>38173</QID><QID>86476</QID></QIDS><COMMENTS>c</COMMENTS>'
    const l = parseSearchListBlock(block)
    expect(l.id).toBe('77')
    expect(l.title).toBe('PCI QIDs')
    expect(l.global).toBe(true)
    expect(l.qids).toEqual(['38173', '86476'])
    expect(l.comments).toBe('c')
  })
})
