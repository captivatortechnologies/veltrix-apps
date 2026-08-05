import validate, { extractProfileSpecs, parseSettingsObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'profiles',
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

const VALID_SETTINGS = '{"version": "10.7.1"}'

describe('Tenable Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid name-only agent profile', async () => {
    const result = await validate(
      makeCtx([{ name: 'Profile', fields: { name: 'Fast Scan', sensor_type: 'agent' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid scanner profile with a JSON settings object', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Profile',
          fields: { name: 'Fast Scan', sensor_type: 'scanners', settingsJson: VALID_SETTINGS },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { sensor_type: 'agent', settingsJson: VALID_SETTINGS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a blank name (whitespace only)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: '   ', sensor_type: 'agent' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), sensor_type: 'agent' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing sensor_type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Fast Scan' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('sensor_type'))).toBe(true)
  })

  it('rejects an invalid sensor_type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Fast Scan', sensor_type: 'agents' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sensor_type')).toBe(true)
  })

  it('rejects invalid JSON settings', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Fast Scan', sensor_type: 'agent', settingsJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects settings that are a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Fast Scan', sensor_type: 'agent', settingsJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects settings that are a JSON primitive, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Fast Scan', sensor_type: 'agent', settingsJson: '42' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects a duplicate (name, sensor_type) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Fast Scan', sensor_type: 'agent' } },
        { name: 'sec2', fields: { name: 'Fast Scan', sensor_type: 'agent' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_profile')).toBe(true)
  })

  it('allows the same name once under "agent" and once under "scanners"', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Fast Scan', sensor_type: 'agent' } },
        { name: 'sec2', fields: { name: 'Fast Scan', sensor_type: 'scanners' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('allows names that differ only in case (matched exactly)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Fast Scan', sensor_type: 'agent' } },
        { name: 'sec2', fields: { name: 'fast scan', sensor_type: 'agent' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractProfileSpecs', () => {
  it('trims fields and drops empty optional values', () => {
    const specs = extractProfileSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'profiles',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Fast Scan  ',
            sensor_type: 'agent',
            description: '   ',
            settingsJson: '   ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Fast Scan')
    expect(specs[0].sensorType).toBe('agent')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].settingsJson).toBeUndefined()
  })
})

describe('parseSettingsObject', () => {
  it('parses a JSON object', () => {
    expect(parseSettingsObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseSettingsObject('[1,2]')).toBe(null)
  })
  it('rejects a JSON primitive', () => {
    expect(parseSettingsObject('42')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseSettingsObject('{nope')).toBe(null)
  })
})
