import validate, {
  buildComputerGroupXml,
  coerceCriterion,
  extractSmartGroupSpecs,
  groupKey,
  indexGroupsByName,
  parseComputerGroupXml,
  tryParseCriteriaJson,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'smart-computer-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'smart-computer-groups',
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

const validCriteria = JSON.stringify([
  { name: 'Operating System Version', searchType: 'is', value: '14.6' },
  { name: 'Last Inventory Update', searchType: 'more than x days ago', value: '7', andOr: 'and' },
])

describe('Jamf Smart Computer Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid smart group', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'macOS 14 Fleet', criteria_json: validCriteria } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { criteria_json: validCriteria } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects invalid JSON criteria', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Group', criteria_json: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects empty criteria', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Group', criteria_json: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('criteria_json'))).toBe(true)
  })

  it('rejects a criterion missing name or searchType', async () => {
    const badCriteria = JSON.stringify([{ value: '14.6' }])
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Group', criteria_json: badCriteria } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('.name') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.includes('searchType') && e.code === 'required')).toBe(true)
  })

  it('rejects an unsupported andOr value', async () => {
    const badCriteria = JSON.stringify([{ name: 'X', searchType: 'is', value: 'Y', andOr: 'xor' }])
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Group', criteria_json: badCriteria } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_and_or')).toBe(true)
  })

  it('rejects duplicate group names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Fleet', criteria_json: validCriteria } },
        { name: 'b', fields: { name: 'fleet', criteria_json: validCriteria } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('groupKey normalizes case and whitespace', () => {
    expect(groupKey('  Fleet ')).toBe('fleet')
  })

  it('tryParseCriteriaJson treats blank text as an empty ok list', () => {
    expect(tryParseCriteriaJson('')).toEqual({ value: [], ok: true })
    expect(tryParseCriteriaJson('   ')).toEqual({ value: [], ok: true })
  })

  it('tryParseCriteriaJson rejects a non-array JSON value', () => {
    expect(tryParseCriteriaJson('{"a":1}').ok).toBe(false)
  })

  it('coerceCriterion defaults andOr to "and" and priority to the index', () => {
    const c = coerceCriterion({ name: 'X', searchType: 'is', value: 'Y' }, 3)
    expect(c.andOr).toBe('and')
    expect(c.priority).toBe(3)
    expect(c.openingParen).toBe(false)
    expect(c.closingParen).toBe(false)
  })

  it('extractSmartGroupSpecs parses full criteria objects', () => {
    const specs = extractSmartGroupSpecs(
      makeCtx([{ name: 'sec', fields: { name: '  Fleet  ', criteria_json: validCriteria } }]).canvas,
    )
    expect(specs[0].name).toBe('Fleet')
    expect(specs[0].criteria).toHaveLength(2)
    expect(specs[0].criteria[0].name).toBe('Operating System Version')
    expect(specs[0].criteria[1].andOr).toBe('and')
  })

  it('indexGroupsByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexGroupsByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })

  it('buildComputerGroupXml + parseComputerGroupXml round-trips name, is_smart and criteria', () => {
    const specs = extractSmartGroupSpecs(
      makeCtx([{ name: 'sec', fields: { name: 'Fleet & Co', criteria_json: validCriteria } }]).canvas,
    )
    const xml = buildComputerGroupXml(specs[0])
    expect(xml).toContain('<is_smart>true</is_smart>')
    expect(xml).toContain('Fleet &amp; Co') // xml-escaped

    const parsed = parseComputerGroupXml(`<computer_group><id>42</id>${xml.replace('<computer_group>', '').replace('</computer_group>', '')}</computer_group>`)
    expect(parsed.id).toBe('42')
    expect(parsed.name).toBe('Fleet & Co') // unescaped back
    expect(parsed.isSmart).toBe(true)
    expect(parsed.criteria).toHaveLength(2)
    expect(parsed.criteria[0].searchType).toBe('is')
    expect(parsed.criteria[1].value).toBe('7')
  })

  it('parseComputerGroupXml handles a group with no criteria block', () => {
    const parsed = parseComputerGroupXml('<computer_group><id>1</id><name>Empty</name><is_smart>true</is_smart></computer_group>')
    expect(parsed.criteria).toEqual([])
  })
})
