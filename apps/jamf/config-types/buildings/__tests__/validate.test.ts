import validate, { buildBuildingBody, buildingKey, extractBuildingSpecs, indexBuildingsByName } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'buildings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'buildings',
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

describe('Jamf Buildings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a building with only a name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'HQ' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a fully populated building', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec',
          fields: { name: 'HQ', street_address_1: '1 Infinite Loop', city: 'Cupertino', state_province: 'CA', zip_postal_code: '95014', country: 'USA' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { city: 'Cupertino' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate building names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'HQ' } },
        { name: 'b', fields: { name: 'hq' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_building')).toBe(true)
  })

  it('buildingKey normalizes case and whitespace', () => {
    expect(buildingKey('  HQ ')).toBe('hq')
  })

  it('extractBuildingSpecs reads every address field', () => {
    const specs = extractBuildingSpecs(
      makeCtx([
        {
          name: 'sec',
          fields: { name: 'HQ', street_address_1: '1 Infinite Loop', street_address_2: 'Suite 1', city: 'Cupertino', state_province: 'CA', zip_postal_code: '95014', country: 'USA' },
        },
      ]).canvas,
    )
    expect(specs[0]).toEqual({
      sectionName: 'sec',
      name: 'HQ',
      streetAddress1: '1 Infinite Loop',
      streetAddress2: 'Suite 1',
      city: 'Cupertino',
      stateProvince: 'CA',
      zipPostalCode: '95014',
      country: 'USA',
    })
  })

  it('buildBuildingBody maps every field', () => {
    const specs = extractBuildingSpecs(makeCtx([{ name: 'sec', fields: { name: 'HQ' } }]).canvas)
    expect(buildBuildingBody(specs[0])).toEqual({
      name: 'HQ',
      streetAddress1: '',
      streetAddress2: '',
      city: '',
      stateProvince: '',
      zipPostalCode: '',
      country: '',
    })
  })

  it('indexBuildingsByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexBuildingsByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
