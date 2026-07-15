import validate, { extractLocationSpecs, parseLocationObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-locations',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-locations',
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

describe('ZIA Locations Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid location (name only)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Location', fields: { name: 'HQ - San Jose', country: 'UNITED_STATES' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { country: 'UNITED_STATES' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 128 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(129) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Branch 1' } },
        { name: 'b', fields: { name: 'branch 1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_location')).toBe(true)
  })

  it('rejects location_json that is not a JSON object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Branch 1', location_json: '["not","an","object"]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_location_json')).toBe(true)
  })

  it('rejects location_json that is malformed JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Branch 1', location_json: '{ not valid' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_location_json')).toBe(true)
  })

  it('accepts a valid location with a well-formed location_json object', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'HQ',
            country: 'UNITED_STATES',
            tz: 'UNITED_STATES_AMERICA_LOS_ANGELES',
            location_json: '{"ipAddresses":["203.0.113.10"],"authRequired":true,"sslScanEnabled":true}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('extractLocationSpecs trims fields and drops blank optionals', () => {
    const specs = extractLocationSpecs(
      makeCtx([
        { name: 'Location', fields: { name: '  HQ  ', country: '   ', tz: '  UTC ', location_json: '   ' } },
      ]).canvas,
    )
    expect(specs[0].name).toBe('HQ')
    expect(specs[0].country).toBeUndefined()
    expect(specs[0].tz).toBe('UTC')
    expect(specs[0].locationJson).toBeUndefined()
  })

  it('parseLocationObject returns the object for an object and null otherwise', () => {
    expect(parseLocationObject('{"authRequired":true}')).toEqual({ authRequired: true })
    expect(parseLocationObject('[1,2,3]')).toBeNull()
    expect(parseLocationObject('42')).toBeNull()
    expect(parseLocationObject('nope')).toBeNull()
  })
})
