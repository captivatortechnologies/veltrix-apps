import validate, { extractListSpecs, itemIdOf, parseItemsArray } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'value-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'value-lists',
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

describe('Elastic Security Value Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal list with no items', async () => {
    const result = await validate(
      makeCtx([{ name: 'List', fields: { id: 'known-vpn-ranges', name: 'Known VPN Ranges', type: 'ip' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a list with items', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'List',
          fields: {
            id: 'vpn',
            name: 'VPN',
            type: 'ip',
            itemsJson: '[{"id":"a","value":"203.0.113.5"},{"id":"b","value":"198.51.100.5"}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing id', async () => {
    const result = await validate(makeCtx([{ name: 'l1', fields: { name: 'X', type: 'ip' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('id'))).toBe(true)
  })

  it('rejects an unrecognised value type', async () => {
    const result = await validate(makeCtx([{ name: 'l1', fields: { id: 'l1', name: 'X', type: 'nonsense' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects invalid itemsJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'l1', fields: { id: 'l1', name: 'X', type: 'ip', itemsJson: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_items')).toBe(true)
  })

  it('rejects an item with no id', async () => {
    const result = await validate(
      makeCtx([{ name: 'l1', fields: { id: 'l1', name: 'X', type: 'ip', itemsJson: '[{"value":"1.2.3.4"}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'item_missing_id')).toBe(true)
  })

  it('rejects an item with no value', async () => {
    const result = await validate(
      makeCtx([{ name: 'l1', fields: { id: 'l1', name: 'X', type: 'ip', itemsJson: '[{"id":"a"}]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'item_missing_value')).toBe(true)
  })

  it('rejects a duplicate item id within a list', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'l1',
          fields: {
            id: 'l1',
            name: 'X',
            type: 'ip',
            itemsJson: '[{"id":"a","value":"1.2.3.4"},{"id":"a","value":"5.6.7.8"}]',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_item')).toBe(true)
  })

  it('rejects a duplicate list id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'l1', fields: { id: 'dup', name: 'X', type: 'ip' } },
        { name: 'l2', fields: { id: 'dup', name: 'Y', type: 'ip' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_list')).toBe(true)
  })
})

describe('extractListSpecs', () => {
  it('trims fields and defaults type to keyword', () => {
    const specs = extractListSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'value-lists',
      items: [],
      sections: [{ name: 'sec1', fields: { id: '  vpn  ', name: '  VPN  ' } }],
      snapshot: {},
    })
    expect(specs[0].id).toBe('vpn')
    expect(specs[0].type).toBe('keyword')
  })
})

describe('parseItemsArray / itemIdOf', () => {
  it('parses a JSON array of items', () => {
    expect(parseItemsArray('[{"id":"a","value":"1"}]')).toEqual([{ id: 'a', value: '1' }])
    expect(parseItemsArray('{"a":1}')).toBeNull()
  })
  it('reads the id off an item object', () => {
    expect(itemIdOf({ id: ' a ' })).toBe('a')
    expect(itemIdOf({})).toBe('')
    expect(itemIdOf(null)).toBe('')
  })
})
