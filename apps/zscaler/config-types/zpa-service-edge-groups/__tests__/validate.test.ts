import validate, { extractServiceEdgeGroupSpecs, readBool, readText } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zpa-service-edge-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zpa-service-edge-groups',
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

/** A fully-specified valid service edge group item. */
function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'West Coast Edge',
    location: 'San Jose, CA, USA',
    latitude: '37.3382',
    longitude: '-121.8863',
    ...overrides,
  }
}

describe('ZPA Service Edge Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully-specified service edge group', async () => {
    const result = await validate(makeCtx([{ name: 'Edge Group', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('requires location, latitude and longitude', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Edge A' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.location'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.latitude'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.longitude'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: validFields({ name: 'Edge Group' }) },
        { name: 'b', fields: validFields({ name: 'edge group' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_service_edge_group')).toBe(true)
  })

  it('defaults enabled to true and applies text defaults', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readText('', '0')).toBe('0')
    expect(readText('  2  ', '0')).toBe('2')
    const specs = extractServiceEdgeGroupSpecs(makeCtx([{ name: 'g', fields: validFields() }]).canvas)
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].versionProfileId).toBe('0')
    expect(specs[0].upgradeDay).toBe('SUNDAY')
    expect(specs[0].upgradeTimeInSecs).toBe('66600')
  })

  it('reads overridden upgrade and location fields', () => {
    const specs = extractServiceEdgeGroupSpecs(
      makeCtx([
        {
          name: 'g',
          fields: validFields({
            country_code: 'US',
            version_profile_id: '2',
            upgrade_day: 'MONDAY',
            upgrade_time_in_secs: '3600',
            enabled: false,
          }),
        },
      ]).canvas,
    )
    expect(specs[0].location).toBe('San Jose, CA, USA')
    expect(specs[0].latitude).toBe('37.3382')
    expect(specs[0].countryCode).toBe('US')
    expect(specs[0].versionProfileId).toBe('2')
    expect(specs[0].upgradeDay).toBe('MONDAY')
    expect(specs[0].upgradeTimeInSecs).toBe('3600')
    expect(specs[0].enabled).toBe(false)
  })
})
