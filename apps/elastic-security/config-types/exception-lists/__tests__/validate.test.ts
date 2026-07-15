import validate, { extractListSpecs, parseItemsArray, itemIdOf } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'exception-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'exception-lists',
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

const VALID_ITEMS =
  '[{"item_id":"allow-svc","name":"Allow svc.exe","entries":[{"field":"process.name","operator":"included","type":"match","value":"svc.exe"}]}]'

describe('Elastic Exception Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal list (no items)', async () => {
    const result = await validate(
      makeCtx([{ name: 'List', fields: { list_id: 'my-list', name: 'My List', type: 'detection', namespaceType: 'single' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a list with folded-in items', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'List',
          fields: { list_id: 'my-list', name: 'My List', type: 'detection', namespaceType: 'single', itemsJson: VALID_ITEMS },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing list_id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'My List' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('list_id'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { list_id: 'my-list' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unknown list type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { list_id: 'my-list', name: 'My List', type: 'bogus' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an unknown namespace type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { list_id: 'my-list', name: 'My List', namespaceType: 'global' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_namespace')).toBe(true)
  })

  it('rejects itemsJson that is not a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { list_id: 'my-list', name: 'My List', itemsJson: '{"item_id":"x"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_items')).toBe(true)
  })

  it('rejects malformed itemsJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { list_id: 'my-list', name: 'My List', itemsJson: '[not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_items')).toBe(true)
  })

  it('rejects an item missing item_id', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { list_id: 'my-list', name: 'My List', itemsJson: '[{"name":"x","entries":[]}]' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'item_missing_id')).toBe(true)
  })

  it('rejects an item missing an entries array', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { list_id: 'my-list', name: 'My List', itemsJson: '[{"item_id":"a","name":"x"}]' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'item_missing_entries')).toBe(true)
  })

  it('rejects duplicate item_id within a list', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            list_id: 'my-list',
            name: 'My List',
            itemsJson:
              '[{"item_id":"a","name":"one","entries":[{"field":"x","operator":"included","type":"match","value":"1"}]},{"item_id":"a","name":"two","entries":[{"field":"y","operator":"included","type":"match","value":"2"}]}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_item')).toBe(true)
  })

  it('rejects a duplicate list_id across the canvas', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { list_id: 'my-list', name: 'One' } },
        { name: 'sec2', fields: { list_id: 'my-list', name: 'Two' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_list')).toBe(true)
  })

  it('warns (but does not reject) an endpoint list type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { list_id: 'endpoint-list', name: 'Endpoint', type: 'endpoint', namespaceType: 'agnostic' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'endpoint_managed')).toBe(true)
  })

  it('warns when an endpoint list is not in the agnostic namespace', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { list_id: 'endpoint-list', name: 'Endpoint', type: 'endpoint', namespaceType: 'single' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'endpoint_namespace')).toBe(true)
  })

  it('warns on an empty entries array', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { list_id: 'my-list', name: 'My List', itemsJson: '[{"item_id":"a","name":"x","entries":[]}]' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_entries')).toBe(true)
  })

  it('allows distinct list_ids', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { list_id: 'list-a', name: 'A' } },
        { name: 'sec2', fields: { list_id: 'list-b', name: 'B' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractListSpecs', () => {
  it('trims fields, drops empty optionals, and defaults type/namespace', () => {
    const specs = extractListSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'exception-lists',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            list_id: '  my-list  ',
            name: '  My List  ',
            description: '  ',
            itemsJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].listId).toBe('my-list')
    expect(specs[0].name).toBe('My List')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].itemsJson).toBeUndefined()
    expect(specs[0].type).toBe('detection')
    expect(specs[0].namespaceType).toBe('single')
  })
})

describe('parseItemsArray', () => {
  it('parses a JSON array', () => {
    expect(parseItemsArray('[{"item_id":"a"}]')).toEqual([{ item_id: 'a' }])
  })
  it('rejects a JSON object', () => {
    expect(parseItemsArray('{"item_id":"a"}')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseItemsArray('[nope')).toBe(null)
  })
})

describe('itemIdOf', () => {
  it('reads and trims a string item_id', () => {
    expect(itemIdOf({ item_id: '  a  ' })).toBe('a')
  })
  it('returns empty for a non-object or missing item_id', () => {
    expect(itemIdOf(null)).toBe('')
    expect(itemIdOf({ name: 'x' })).toBe('')
    expect(itemIdOf([1, 2])).toBe('')
  })
})
