import validate, { extractConnectorSpecs, parseParamsObject } from '../validate'
import { buildConnectorBody, buildSchedule } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'connectors',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'connectors',
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
    toolType: 'tenable-vm',
    entityType: 'connectors',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_UUID = '11111111-2222-3333-4444-555555555555'
const VALID_PARAMS = '{"access_key":"AKIAEXAMPLE","secret_key":"s3cr3t"}'

/** A fully valid AWS connector, overridable per test. */
function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'AWS Prod',
    type: 'aws',
    paramsJson: VALID_PARAMS,
    networkUuid: VALID_UUID,
    scheduleValue: 4,
    scheduleUnits: 'hours',
    ...overrides,
  }
}

describe('Tenable Connectors Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified connector', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a minimal connector (no network, no schedule)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Conn', fields: { name: 'Azure', type: 'azure', paramsJson: VALID_PARAMS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ type: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects missing params (write-only credentials are required)', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ paramsJson: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('paramsJson'))).toBe(true)
  })

  it('rejects an unknown cloud provider type', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ type: 'oracle' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects malformed params JSON', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ paramsJson: '{not json' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_params')).toBe(true)
  })

  it('rejects params that are a JSON array, not an object', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ paramsJson: '[1,2,3]' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_params')).toBe(true)
  })

  it('rejects a malformed network UUID', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ networkUuid: 'not-a-uuid' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_network')).toBe(true)
  })

  it('rejects a non-positive schedule value', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ scheduleValue: 0 }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_schedule_value')).toBe(true)
  })

  it('rejects unknown schedule units', async () => {
    const result = await validate(makeCtx([{ name: 'Conn', fields: validFields({ scheduleUnits: 'weeks' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_schedule_units')).toBe(true)
  })

  it('rejects duplicate connector names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ name: 'AWS Prod' }) },
        { name: 'sec2', fields: validFields({ name: 'aws prod' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractConnectorSpecs', () => {
  it('trims fields, lower-cases the type, and coerces the schedule value', () => {
    const specs = extractConnectorSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: '  AWS Prod  ',
            type: '  AWS  ',
            paramsJson: '  {"a":1}  ',
            networkUuid: '  ',
            scheduleValue: '6',
            scheduleUnits: ' DAYS ',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('AWS Prod')
    expect(specs[0].type).toBe('aws')
    expect(specs[0].paramsJson).toBe('{"a":1}')
    expect(specs[0].networkUuid).toBeUndefined()
    expect(specs[0].scheduleValue).toBe(6)
    expect(specs[0].scheduleUnits).toBe('days')
  })
})

describe('buildSchedule', () => {
  it('returns undefined when no interval is configured', () => {
    expect(buildSchedule({ sectionName: 's', name: 'x', type: 'aws' })).toBeUndefined()
  })
  it('defaults units to hours when only a value is set', () => {
    expect(buildSchedule({ sectionName: 's', name: 'x', type: 'aws', scheduleValue: 3 })).toEqual({
      units: 'hours',
      value: 3,
    })
  })
})

describe('buildConnectorBody', () => {
  it('WRAPS the payload in a top-level "connector" object with params', () => {
    const body = buildConnectorBody(
      {
        sectionName: 's',
        name: 'AWS Prod',
        type: 'aws',
        networkUuid: VALID_UUID,
        scheduleValue: 4,
        scheduleUnits: 'hours',
      },
      { access_key: 'AKIA', secret_key: 's3cr3t' },
    )
    expect(body).toEqual({
      connector: {
        name: 'AWS Prod',
        type: 'aws',
        params: { access_key: 'AKIA', secret_key: 's3cr3t' },
        schedule: { units: 'hours', value: 4 },
        network_uuid: VALID_UUID,
      },
    })
  })

  it('omits schedule and network_uuid when they are not configured', () => {
    const body = buildConnectorBody(
      { sectionName: 's', name: 'GCP', type: 'gcp' },
      { key: 'v' },
    ) as { connector: Record<string, unknown> }
    expect(body.connector.schedule).toBeUndefined()
    expect(body.connector.network_uuid).toBeUndefined()
    expect(body.connector.params).toEqual({ key: 'v' })
  })
})

describe('parseParamsObject', () => {
  it('parses a JSON object', () => {
    expect(parseParamsObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseParamsObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseParamsObject('{nope')).toBe(null)
  })
})
