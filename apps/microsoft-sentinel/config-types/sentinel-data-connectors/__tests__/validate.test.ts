import validate, { extractDataConnectorSpecs, connectorKey, connectorDataTypeStates } from '../validate'
import { buildDataConnectorBody } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-data-connectors',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-data-connectors',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      subscription_id: '11111111-1111-1111-1111-111111111111',
      resource_group: 'rg-soc',
      workspace_name: 'ws-sentinel',
      azure_cloud: 'commercial',
    },
    platform: stubPlatform,
  }
}

const TENANT = '2070ecc9-b4d5-4ae4-adaa-936fa1954fa8'

const validAad = {
  connector_id: 'entra-id-protection',
  kind: 'AzureActiveDirectory',
  tenant_id: TENANT,
  enable_alerts: true,
}

const validOffice = {
  connector_id: 'm365',
  kind: 'Office365',
  tenant_id: TENANT,
  enable_exchange: true,
  enable_sharepoint: true,
  enable_teams: false,
}

describe('Sentinel Data Connectors Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete tenant (alerts) connector', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validAad } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a complete Office 365 connector', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validOffice } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a connector id and a tenant id', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validAad, connector_id: '', tenant_id: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.connector_id') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.tenant_id') && e.code === 'required')).toBe(true)
  })

  it('rejects a non-GUID tenant id', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validAad, tenant_id: 'not-a-guid' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_tenant')).toBe(true)
  })

  it('rejects an unsupported kind', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validAad, kind: 'AmazonWebServicesCloudTrail' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_kind')).toBe(true)
  })

  it('rejects a connector id with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validAad, connector_id: 'bad id!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_connector_id')).toBe(true)
  })

  it('requires at least one data type enabled', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validAad, enable_alerts: false } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_data_type')).toBe(true)
  })

  it('rejects duplicate connector ids case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validAad, connector_id: 'entra-id-protection' } },
        { name: 'b', fields: { ...validAad, connector_id: 'Entra-ID-Protection' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_connector')).toBe(true)
  })

  it('extracts only the kind-relevant data types', () => {
    const aad = extractDataConnectorSpecs(makeCtx([{ name: 'c', fields: { ...validAad } }]).canvas)
    expect(aad[0].dataTypes).toEqual({ alerts: true })
    expect(connectorKey('Entra-ID-Protection')).toBe('entra-id-protection')

    const office = extractDataConnectorSpecs(makeCtx([{ name: 'c', fields: { ...validOffice } }]).canvas)
    expect(office[0].dataTypes).toEqual({ exchange: true, sharePoint: true, teams: false })
  })

  it('builds a body with kind, tenantId and per-data-type state', () => {
    const office = extractDataConnectorSpecs(makeCtx([{ name: 'c', fields: { ...validOffice } }]).canvas)
    const body = buildDataConnectorBody(office[0]) as {
      kind: string
      properties: { tenantId: string; dataTypes: Record<string, { state: string }> }
    }
    expect(body.kind).toBe('Office365')
    expect(body.properties.tenantId).toBe(TENANT)
    expect(body.properties.dataTypes.exchange.state).toBe('Enabled')
    expect(body.properties.dataTypes.teams.state).toBe('Disabled')
    expect(connectorDataTypeStates(office[0])).toEqual({ exchange: 'Enabled', sharePoint: 'Enabled', teams: 'Disabled' })
  })
})
