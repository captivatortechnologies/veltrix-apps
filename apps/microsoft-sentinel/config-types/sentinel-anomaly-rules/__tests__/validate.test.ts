import validate, { extractAnomalySpecs, anomalyKey, thresholdObservationsOf } from '../validate'
import { buildAnomalyBody } from '../deploy'
import { SENTINEL_API_VERSION } from '../../../lib/sentinel'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-anomaly-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-anomaly-rules',
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

const validAnomaly = {
  name: 'Login from unusual region',
  description: 'Login from a rarely seen source region.',
  enabled: true,
  settings_definition_id: 'f209187f-1d17-4431-94af-c141bf5f23db',
  settings_status: 'Production',
  frequency: 'PT1H',
  anomaly_version: '1.0.5',
  is_default_settings: true,
  tactics: ['Exfiltration', 'CommandAndControl'],
  techniques: ['T1037', 'T1021'],
}

const observationsJson = JSON.stringify({
  thresholdObservations: [
    { name: 'Number of standard deviations', minimum: '2', maximum: '10', value: '3' },
  ],
})

describe('Sentinel Anomaly Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete anomaly setting', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name and a settingsDefinitionId', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly, name: '', settings_definition_id: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.name') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.settings_definition_id') && e.code === 'required')).toBe(true)
  })

  it('rejects a settingsDefinitionId that is not a GUID', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly, settings_definition_id: 'not-a-guid' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_guid')).toBe(true)
  })

  it('rejects an invalid settings status', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly, settings_status: 'Testing' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects a non ISO-8601 frequency', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly, frequency: '1 hour' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('rejects tactics that are not AttackTactic enum values', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly, tactics: ['Exfiltration', 'NotATactic'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_tactic')).toBe(true)
  })

  it('rejects duplicate setting names that slug to the same id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validAnomaly, name: 'Login from unusual region' } },
        { name: 'b', fields: { ...validAnomaly, name: 'Login   From   Unusual Region' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_setting')).toBe(true)
  })

  it('extract derives a deterministic settings resource name and reads fields', () => {
    const specs = extractAnomalySpecs(makeCtx([{ name: 'a', fields: { ...validAnomaly, name: '  Login From Unusual Region!  ' } }]).canvas)
    expect(specs[0].name).toBe('Login From Unusual Region!')
    expect(specs[0].settingsResourceName).toBe('login-from-unusual-region')
    expect(specs[0].tactics).toEqual(['Exfiltration', 'CommandAndControl'])
    expect(anomalyKey('Login From Unusual Region!')).toBe('login-from-unusual-region')
  })

  it('extract defaults frequency and anomalyVersion when blank', () => {
    const specs = extractAnomalySpecs(
      makeCtx([{ name: 'a', fields: { name: 'X', settings_definition_id: validAnomaly.settings_definition_id } }]).canvas,
    )
    expect(specs[0].frequency).toBe('PT1H')
    expect(specs[0].anomalyVersion).toBe('1.0.0')
    expect(specs[0].settingsStatus).toBe('Production')
    // A customized copy is non-default by default (each definition has exactly one
    // built-in default at its own resource name).
    expect(specs[0].isDefaultSettings).toBe(false)
  })

  it('builds an Anomaly body with the required mapped properties', () => {
    const specs = extractAnomalySpecs(makeCtx([{ name: 'a', fields: { ...validAnomaly } }]).canvas)
    const body = buildAnomalyBody(specs[0]) as { kind: string; properties: Record<string, unknown> }
    expect(body.kind).toBe('Anomaly')
    expect(body.properties.displayName).toBe('Login from unusual region')
    expect(body.properties.settingsStatus).toBe('Production')
    expect(body.properties.enabled).toBe(true)
    expect(body.properties.settingsDefinitionId).toBe('f209187f-1d17-4431-94af-c141bf5f23db')
    expect(body.properties.frequency).toBe('PT1H')
    expect(body.properties.anomalyVersion).toBe('1.0.5')
    expect(body.properties.isDefaultSettings).toBe(true)
    expect(body.properties.tactics).toEqual(['Exfiltration', 'CommandAndControl'])
    expect(body.properties.techniques).toEqual(['T1037', 'T1021'])
  })

  it('omits customizableObservations from the body when none is supplied', () => {
    const specs = extractAnomalySpecs(makeCtx([{ name: 'a', fields: { ...validAnomaly } }]).canvas)
    const body = buildAnomalyBody(specs[0]) as { kind: string; properties: Record<string, unknown> }
    expect(body.properties.customizableObservations).toBeUndefined()
  })

  it('validates and includes a well-formed customizableObservations object', async () => {
    const fields = { ...validAnomaly, customizable_observations: observationsJson }
    const result = await validate(makeCtx([{ name: 'a', fields }]))
    expect(result.valid).toBe(true)
    const specs = extractAnomalySpecs(makeCtx([{ name: 'a', fields }]).canvas)
    const thresholds = thresholdObservationsOf(specs[0].customizableObservations)
    expect(thresholds).toHaveLength(1)
    expect(thresholds[0].name).toBe('Number of standard deviations')
    expect(thresholds[0].value).toBe('3')
    const body = buildAnomalyBody(specs[0]) as { properties: Record<string, unknown> }
    expect(body.properties.customizableObservations).toBeDefined()
  })

  it('rejects customizableObservations that is not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly, customizable_observations: '{ not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a threshold value outside its declared range', async () => {
    const outOfRange = JSON.stringify({
      thresholdObservations: [{ name: 'Std devs', minimum: '2', maximum: '10', value: '25' }],
    })
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly, customizable_observations: outOfRange } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'threshold_out_of_range')).toBe(true)
  })

  it('rejects an observation group that is not an array', async () => {
    const bad = JSON.stringify({ thresholdObservations: { name: 'x' } })
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validAnomaly, customizable_observations: bad } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_observation')).toBe(true)
  })

  it('anomaly settings use the GA api-version', () => {
    expect(SENTINEL_API_VERSION).toBe('2024-09-01')
  })
})
