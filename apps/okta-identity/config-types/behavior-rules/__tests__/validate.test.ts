import validate, {
  checkBehaviorSettings,
  extractBehaviorSpecs,
  parseSettingsObject,
} from '../validate'
import { buildBehaviorBody, stripReadOnlyBehaviorFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'behavior-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'behavior-rules',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'okta-identity',
    entityType: 'behavior-rules',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VELOCITY_SETTINGS = '{"velocityKph":805}'
const LOCATION_CITY_SETTINGS = '{"granularity":"CITY","minEventsNeededForEvaluation":0}'
const LOCATION_LATLONG_SETTINGS = '{"granularity":"LatLong","radiusKilometers":20}'

describe('Okta Behavior Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid VELOCITY behavior', async () => {
    const result = await validate(
      makeCtx([{ name: 'Behavior', fields: { type: 'VELOCITY', name: 'Impossible Travel', status: 'ACTIVE', settingsJson: VELOCITY_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid ANOMALOUS_LOCATION behavior (CITY)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Behavior', fields: { type: 'ANOMALOUS_LOCATION', name: 'New City', settingsJson: LOCATION_CITY_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid ANOMALOUS_LOCATION behavior (LatLong with radius)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Behavior', fields: { type: 'ANOMALOUS_LOCATION', name: 'New Area', settingsJson: LOCATION_LATLONG_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates an ANOMALOUS_IP behavior with no settings', async () => {
    const result = await validate(
      makeCtx([{ name: 'Behavior', fields: { type: 'ANOMALOUS_IP', name: 'New IP' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates an ANOMALOUS_DEVICE behavior with no settings', async () => {
    const result = await validate(
      makeCtx([{ name: 'Behavior', fields: { type: 'ANOMALOUS_DEVICE', name: 'New Device' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'VELOCITY', settingsJson: VELOCITY_SETTINGS } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 128 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'VELOCITY', name: 'x'.repeat(129), settingsJson: VELOCITY_SETTINGS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Type' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an unknown behavior type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'MAGIC', name: 'Bad Type' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'VELOCITY', name: 'Bad Status', status: 'PAUSED', settingsJson: VELOCITY_SETTINGS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects malformed settings JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'ANOMALOUS_IP', name: 'Bad JSON', settingsJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects settings that are a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'ANOMALOUS_IP', name: 'Array Settings', settingsJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects a VELOCITY behavior missing velocityKph', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'VELOCITY', name: 'No Kph', settingsJson: '{}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_settings')).toBe(true)
  })

  it('rejects a VELOCITY behavior with no settings at all', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'VELOCITY', name: 'No Settings' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_settings')).toBe(true)
  })

  it('rejects a VELOCITY behavior with a non-positive velocityKph', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'VELOCITY', name: 'Zero Kph', settingsJson: '{"velocityKph":0}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_settings')).toBe(true)
  })

  it('rejects an ANOMALOUS_LOCATION behavior missing granularity', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'ANOMALOUS_LOCATION', name: 'No Gran', settingsJson: '{"minEventsNeededForEvaluation":0}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_settings')).toBe(true)
  })

  it('rejects an ANOMALOUS_LOCATION behavior with an unknown granularity', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'ANOMALOUS_LOCATION', name: 'Bad Gran', settingsJson: '{"granularity":"PLANET"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_settings')).toBe(true)
  })

  it('rejects a LatLong ANOMALOUS_LOCATION behavior missing radiusKilometers', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'ANOMALOUS_LOCATION', name: 'No Radius', settingsJson: '{"granularity":"LatLong"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_settings')).toBe(true)
  })

  it('rejects a duplicate behavior name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: 'VELOCITY', name: 'Travel', settingsJson: VELOCITY_SETTINGS } },
        { name: 'sec2', fields: { type: 'ANOMALOUS_IP', name: 'travel' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('accepts a VELOCITY type entered in lower case', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'velocity', name: 'Lower Type', settingsJson: VELOCITY_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractBehaviorSpecs', () => {
  it('trims fields, upper-cases the type/status and drops blank settings', () => {
    const specs = extractBehaviorSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { type: '  velocity  ', name: '  Impossible Travel  ', status: ' inactive ', settingsJson: '   ' },
        },
      ]),
    )
    expect(specs[0].type).toBe('VELOCITY')
    expect(specs[0].name).toBe('Impossible Travel')
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].settingsJson).toBeUndefined()
  })

  it('defaults status to ACTIVE when unset', () => {
    const specs = extractBehaviorSpecs(makeCanvas([{ name: 'sec1', fields: { type: 'ANOMALOUS_IP', name: 'B' } }]))
    expect(specs[0].status).toBe('ACTIVE')
  })
})

describe('parseSettingsObject', () => {
  it('parses a JSON object', () => {
    expect(parseSettingsObject('{"velocityKph":805}')).toEqual({ velocityKph: 805 })
  })
  it('rejects a JSON array', () => {
    expect(parseSettingsObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseSettingsObject('{nope')).toBe(null)
  })
})

describe('checkBehaviorSettings', () => {
  it('passes a VELOCITY behavior with velocityKph and fails one without', () => {
    expect(checkBehaviorSettings('VELOCITY', { velocityKph: 805 })).toBeNull()
    expect(checkBehaviorSettings('VELOCITY', {})).toMatch(/velocityKph/)
  })
  it('passes an ANOMALOUS_LOCATION with a granularity and fails one without', () => {
    expect(checkBehaviorSettings('ANOMALOUS_LOCATION', { granularity: 'COUNTRY' })).toBeNull()
    expect(checkBehaviorSettings('ANOMALOUS_LOCATION', {})).toMatch(/granularity/)
  })
  it('requires radiusKilometers only for LatLong granularity', () => {
    expect(checkBehaviorSettings('ANOMALOUS_LOCATION', { granularity: 'LatLong' })).toMatch(/radiusKilometers/)
    expect(checkBehaviorSettings('ANOMALOUS_LOCATION', { granularity: 'LatLong', radiusKilometers: 20 })).toBeNull()
  })
  it('requires no settings for ANOMALOUS_IP / ANOMALOUS_DEVICE', () => {
    expect(checkBehaviorSettings('ANOMALOUS_IP', {})).toBeNull()
    expect(checkBehaviorSettings('ANOMALOUS_DEVICE', {})).toBeNull()
  })
})

describe('buildBehaviorBody', () => {
  it('sends type/name and the settings object when non-empty', () => {
    const body = buildBehaviorBody(
      { sectionName: 's', type: 'VELOCITY', name: 'Travel', status: 'ACTIVE' },
      { velocityKph: 805 },
    )
    expect(body).toEqual({ type: 'VELOCITY', name: 'Travel', settings: { velocityKph: 805 } })
  })

  it('omits settings entirely when the blob is empty', () => {
    const body = buildBehaviorBody(
      { sectionName: 's', type: 'ANOMALOUS_IP', name: 'IP', status: 'ACTIVE' },
      {},
    )
    expect(body).toEqual({ type: 'ANOMALOUS_IP', name: 'IP' })
    expect(body.settings).toBeUndefined()
  })

  it('lets the modeled type/name win over any blob values', () => {
    const body = buildBehaviorBody(
      { sectionName: 's', type: 'VELOCITY', name: 'Travel', status: 'ACTIVE' },
      { velocityKph: 805, name: 'HIJACK', type: 'ANOMALOUS_IP' },
    )
    expect(body.type).toBe('VELOCITY')
    expect(body.name).toBe('Travel')
    expect(body.settings).toEqual({ velocityKph: 805, name: 'HIJACK', type: 'ANOMALOUS_IP' })
  })
})

describe('stripReadOnlyBehaviorFields', () => {
  it('removes id/created/lastUpdated/system/_links/_embedded/status but keeps type/name/settings', () => {
    const stripped = stripReadOnlyBehaviorFields({
      id: 'guobehavior',
      name: 'Travel',
      type: 'VELOCITY',
      status: 'ACTIVE',
      system: false,
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
      settings: { velocityKph: 805 },
    })
    expect(stripped).toEqual({
      name: 'Travel',
      type: 'VELOCITY',
      settings: { velocityKph: 805 },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
  })
})
