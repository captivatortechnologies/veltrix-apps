import validate, {
  buildStaticGroupXml,
  extractStaticGroupSpecs,
  parseComputerLookupXml,
  strList,
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
    configTypeId: 'static-computer-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'static-computer-groups',
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

describe('Jamf Static Computer Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with members', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Exec Fleet', member_serial_numbers: ['C02Q7KHTGFWF'] } }]))
    expect(result.valid).toBe(true)
  })

  it('validates an intentionally empty group', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Empty Group' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { member_serial_numbers: ['C02Q7KHTGFWF'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate serial numbers within one group (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'Fleet', member_serial_numbers: ['ABC123', 'abc123'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_member')).toBe(true)
  })

  it('rejects duplicate group names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Fleet' } },
        { name: 'b', fields: { name: 'fleet' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('strList handles arrays, comma strings and blanks', () => {
    expect(strList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(strList('a, b ,')).toEqual(['a', 'b'])
    expect(strList(undefined)).toEqual([])
  })

  it('extractStaticGroupSpecs trims name and reads member serial numbers', () => {
    const specs = extractStaticGroupSpecs(
      makeCtx([{ name: 'sec', fields: { name: '  Exec Fleet  ', member_serial_numbers: ['C02Q7KHTGFWF', ' C02ABCDEFGH '] } }]).canvas,
    )
    expect(specs[0].name).toBe('Exec Fleet')
    expect(specs[0].memberSerialNumbers).toEqual(['C02Q7KHTGFWF', 'C02ABCDEFGH'])
  })

  it('buildStaticGroupXml renders is_smart=false and every resolved member', () => {
    const xml = buildStaticGroupXml(
      { name: 'Exec Fleet' },
      [{ id: '1', name: "Joe's iMac", serialNumber: 'C02Q7KHTGFWF' }],
    )
    expect(xml).toContain('<is_smart>false</is_smart>')
    expect(xml).toContain('<computer><id>1</id><name>Joe&apos;s iMac</name><serial_number>C02Q7KHTGFWF</serial_number></computer>')
  })

  it('parseComputerLookupXml reads id/name/serial_number nested under <general>', () => {
    const xml = '<computer><general><id>1</id><name>Joes iMac</name><serial_number>C02Q7KHTGFWF</serial_number></general></computer>'
    const parsed = parseComputerLookupXml(xml)
    expect(parsed.id).toBe('1')
    expect(parsed.name).toBe('Joes iMac')
    expect(parsed.serialNumber).toBe('C02Q7KHTGFWF')
  })

  it('parseComputerLookupXml falls back to a flat root when there is no <general> wrapper', () => {
    const xml = '<computer_group><id>42</id></computer_group>'
    expect(parseComputerLookupXml(xml).id).toBe('42')
  })
})
