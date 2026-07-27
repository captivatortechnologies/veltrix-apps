import validate, {
  parseDeviceControlSettings,
  extractDeviceControlSpecs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'usb-device-control-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'usb-device-control-policies',
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

function validPolicyFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Locked-Down Workstations',
    platform: 'Windows',
    enabled: true,
    hostGroups: 'group-id-1',
    settings: JSON.stringify({
      classes: [
        { id: 'MASS_STORAGE', action: 'FULL_BLOCK' },
        { id: 'WIRELESS', action: 'FULL_ACCESS' },
      ],
    }),
    ...overrides,
  }
}

describe('CrowdStrike USB Device Control Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid policy configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Policy', fields: validPolicyFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing policy name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects the reserved platform_default name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: 'platform_default' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects unsupported platforms', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ platform: 'Linux' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('normalizes platform casing to the API title case', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ platform: 'windows' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when an enabled policy has no host groups', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ hostGroups: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_host_groups')).toBe(true)
  })

  it('rejects invalid settings JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ settings: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects a device class with an unknown action', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validPolicyFields({
            settings: JSON.stringify({ classes: [{ id: 'MASS_STORAGE', action: 'ALLOW' }] }),
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects duplicate policy names per platform', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPolicyFields() },
        { name: 'sec2', fields: validPolicyFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows the same policy name on different platforms', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPolicyFields() },
        { name: 'sec2', fields: validPolicyFields({ platform: 'Mac' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('parseDeviceControlSettings', () => {
  it('accepts a classes array with allowed actions', () => {
    const { settings, errors } = parseDeviceControlSettings(
      JSON.stringify({
        classes: [
          { id: 'MASS_STORAGE', action: 'READ_ONLY' },
          { id: 'PRINTER', action: 'FULL_ACCESS' },
        ],
      }),
    )
    expect(errors).toHaveLength(0)
    expect(settings).toBeTruthy()
  })

  it('rejects an unknown class action', () => {
    const { errors } = parseDeviceControlSettings(
      JSON.stringify({ classes: [{ id: 'MASS_STORAGE', action: 'ALLOW' }] }),
    )
    expect(errors.some((e) => e.includes('must be one of'))).toBe(true)
  })

  it('rejects settings that is not a JSON object', () => {
    const { errors } = parseDeviceControlSettings(
      JSON.stringify([{ id: 'MASS_STORAGE', action: 'FULL_BLOCK' }]),
    )
    expect(errors.some((e) => e.includes('must be a JSON object'))).toBe(true)
  })

  it('rejects a settings object with no classes array', () => {
    const { errors } = parseDeviceControlSettings(JSON.stringify({ end_user_notification: 'TRUE' }))
    expect(errors.some((e) => e.includes('classes'))).toBe(true)
  })

  it('rejects a class missing its id', () => {
    const { errors } = parseDeviceControlSettings(
      JSON.stringify({ classes: [{ action: 'FULL_BLOCK' }] }),
    )
    expect(errors.some((e) => e.includes('non-empty string'))).toBe(true)
  })

  it('rejects duplicate class ids', () => {
    const { errors } = parseDeviceControlSettings(
      JSON.stringify({
        classes: [
          { id: 'MASS_STORAGE', action: 'FULL_BLOCK' },
          { id: 'MASS_STORAGE', action: 'FULL_ACCESS' },
        ],
      }),
    )
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('rejects a non-array exceptions field', () => {
    const { errors } = parseDeviceControlSettings(
      JSON.stringify({ classes: [{ id: 'MASS_STORAGE', action: 'FULL_ACCESS', exceptions: {} }] }),
    )
    expect(errors.some((e) => e.includes('exceptions'))).toBe(true)
  })

  it('returns null settings for empty input', () => {
    expect(parseDeviceControlSettings(undefined)).toEqual({ settings: null, errors: [] })
  })
})

describe('extractDeviceControlSpecs', () => {
  it('parses host groups from comma-separated tags', () => {
    const specs = extractDeviceControlSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'usb-device-control-policies',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: 'p1', platform: 'Mac', hostGroups: 'g1, g2' } },
      ],
      snapshot: {},
    })
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
    expect(specs[0].platform).toBe('Mac')
    expect(specs[0].enabled).toBe(false)
  })
})
