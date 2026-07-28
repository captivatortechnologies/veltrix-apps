import validate, {
  extractProductSettingSpecs,
  settingKey,
  isToggleSetting,
  readList,
} from '../validate'
import { buildSettingBody } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-product-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-product-settings',
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

const validUeba = {
  setting: 'Ueba',
  data_sources: ['AuditLogs', 'SigninLogs'],
}

const validEntityAnalytics = {
  setting: 'EntityAnalytics',
  entity_providers: ['ActiveDirectory', 'AzureActiveDirectory'],
}

const validAnomalies = {
  setting: 'Anomalies',
  enabled: true,
}

describe('Sentinel Product Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete UEBA setting', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { ...validUeba } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a complete Entity Analytics setting', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { ...validEntityAnalytics } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates an Anomalies toggle setting', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { ...validAnomalies } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('treats empty entity providers / data sources as a valid (off) state', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { setting: 'Ueba', data_sources: [] } },
        { name: 'b', fields: { setting: 'EntityAnalytics', entity_providers: [] } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a setting', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { setting: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.setting') && e.code === 'required')).toBe(true)
  })

  it('rejects an unsupported setting name', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { setting: 'FusionMagic' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_setting')).toBe(true)
  })

  it('rejects an invalid UEBA data source', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { setting: 'Ueba', data_sources: ['NotAReal Source'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_data_source')).toBe(true)
  })

  it('rejects an invalid entity provider', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { setting: 'EntityAnalytics', entity_providers: ['OnPremGarbage'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_entity_provider')).toBe(true)
  })

  it('rejects declaring the same singleton twice', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { setting: 'Ueba', data_sources: ['AuditLogs'] } },
        { name: 'b', fields: { setting: 'Ueba', data_sources: ['SigninLogs'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_setting')).toBe(true)
  })

  it('normalises fields away from the irrelevant setting', () => {
    const ueba = extractProductSettingSpecs(makeCtx([{ name: 's', fields: { ...validUeba, enabled: true, entity_providers: ['ActiveDirectory'] } }]).canvas)
    expect(ueba[0].dataSources).toEqual(['AuditLogs', 'SigninLogs'])
    expect(ueba[0].entityProviders).toEqual([])
    expect(ueba[0].isEnabled).toBe(false)

    const anomalies = extractProductSettingSpecs(makeCtx([{ name: 's', fields: { ...validAnomalies, data_sources: ['AuditLogs'] } }]).canvas)
    expect(anomalies[0].isEnabled).toBe(true)
    expect(anomalies[0].dataSources).toEqual([])

    expect(settingKey('UEBA')).toBe('ueba')
    expect(isToggleSetting('EyesOn')).toBe(true)
    expect(isToggleSetting('Ueba')).toBe(false)
  })

  it('de-duplicates list values case-insensitively while keeping first casing', () => {
    expect(readList(['AuditLogs', 'auditlogs', 'SigninLogs'])).toEqual(['AuditLogs', 'SigninLogs'])
    expect(readList('AuditLogs, SigninLogs')).toEqual(['AuditLogs', 'SigninLogs'])
  })

  it('builds a toggle body for Anomalies / EyesOn', () => {
    const anomalies = extractProductSettingSpecs(makeCtx([{ name: 's', fields: { setting: 'Anomalies', enabled: false } }]).canvas)
    const body = buildSettingBody(anomalies[0]) as { kind: string; properties: { isEnabled: boolean } }
    expect(body.kind).toBe('Anomalies')
    expect(body.properties.isEnabled).toBe(false)
  })

  it('builds an entityProviders body for Entity Analytics', () => {
    const ea = extractProductSettingSpecs(makeCtx([{ name: 's', fields: { ...validEntityAnalytics } }]).canvas)
    const body = buildSettingBody(ea[0]) as { kind: string; properties: { entityProviders: string[] } }
    expect(body.kind).toBe('EntityAnalytics')
    expect(body.properties.entityProviders).toEqual(['ActiveDirectory', 'AzureActiveDirectory'])
  })

  it('builds a dataSources body for UEBA', () => {
    const ueba = extractProductSettingSpecs(makeCtx([{ name: 's', fields: { ...validUeba } }]).canvas)
    const body = buildSettingBody(ueba[0]) as { kind: string; properties: { dataSources: string[] } }
    expect(body.kind).toBe('Ueba')
    expect(body.properties.dataSources).toEqual(['AuditLogs', 'SigninLogs'])
  })
})
