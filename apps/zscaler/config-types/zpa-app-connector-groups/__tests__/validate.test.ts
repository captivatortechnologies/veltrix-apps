import validate, { extractAppConnectorGroupSpecs, readBool } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zpa-app-connector-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zpa-app-connector-groups',
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

const validFields = {
  name: 'US East Connectors',
  location: 'San Jose, CA, USA',
  latitude: '37.3382',
  longitude: '-121.8863',
}

describe('ZPA App Connector Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid App Connector group', async () => {
    const result = await validate(makeCtx([{ name: 'App Connector Group', fields: { ...validFields, enabled: true } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { location: 'X', latitude: '1', longitude: '2' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects missing location, latitude and longitude', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Corp Connectors' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('location'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('latitude'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('longitude'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Corp Connectors' } },
        { name: 'b', fields: { ...validFields, name: 'corp connectors' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_app_connector_group')).toBe(true)
  })

  it('applies defaults and coerces latitude/longitude to strings', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    const specs = extractAppConnectorGroupSpecs(
      makeCtx([{ name: 'g', fields: { name: 'X', location: 'LA', latitude: 34.05, longitude: -118.24 } }]).canvas,
    )
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].dnsQueryType).toBe('IPV4_IPV6')
    expect(specs[0].versionProfileId).toBe('0')
    expect(specs[0].latitude).toBe('34.05')
    expect(specs[0].longitude).toBe('-118.24')
  })
})
