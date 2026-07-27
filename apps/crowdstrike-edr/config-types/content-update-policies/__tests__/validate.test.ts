import validate, { parseContentUpdateSettings, extractContentUpdatePolicySpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'content-update-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'content-update-policies',
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
    name: 'Production Content Ring',
    enabled: true,
    hostGroups: 'group-id-1',
    settings: JSON.stringify({
      ring_assignment_settings: [
        { id: 'sensor_operations', ring_assignment: 'ga', delay_hours: '0' },
        { id: 'system_critical', ring_assignment: 'ga', delay_hours: '0' },
      ],
    }),
    ...overrides,
  }
}

describe('CrowdStrike Content Update Policies Validate Handler', () => {
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

  it('rejects settings that lack a ring_assignment_settings array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ settings: JSON.stringify({ foo: 'bar' }) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects duplicate policy names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPolicyFields() },
        { name: 'sec2', fields: validPolicyFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseContentUpdateSettings', () => {
  it('accepts a valid ring_assignment_settings object', () => {
    const { settings, errors } = parseContentUpdateSettings(
      JSON.stringify({
        ring_assignment_settings: [
          { id: 'sensor_operations', ring_assignment: 'ga', delay_hours: '4' },
          { id: 'vulnerability_management', ring_assignment: 'ea' },
          { id: 'rapid_response_al_bl_listing', ring_assignment: 'pause' },
        ],
      }),
    )
    expect(errors).toHaveLength(0)
    expect(settings?.ring_assignment_settings).toHaveLength(3)
  })

  it('rejects an unknown ring_assignment value', () => {
    const { errors } = parseContentUpdateSettings(
      JSON.stringify({ ring_assignment_settings: [{ id: 'sensor_operations', ring_assignment: 'canary' }] }),
    )
    expect(errors.some((e) => e.includes('must be one of'))).toBe(true)
  })

  it('rejects pause for system_critical', () => {
    const { errors } = parseContentUpdateSettings(
      JSON.stringify({ ring_assignment_settings: [{ id: 'system_critical', ring_assignment: 'pause' }] }),
    )
    expect(errors.some((e) => e.includes('not permitted for system_critical'))).toBe(true)
  })

  it('rejects a non-array ring_assignment_settings', () => {
    const { errors } = parseContentUpdateSettings(
      JSON.stringify({ ring_assignment_settings: 'ga' }),
    )
    expect(errors.some((e) => e.includes('ring_assignment_settings'))).toBe(true)
  })

  it('rejects a top-level array', () => {
    const { errors } = parseContentUpdateSettings(JSON.stringify([{ id: 'sensor_operations' }]))
    expect(errors.some((e) => e.includes('JSON object'))).toBe(true)
  })

  it('rejects duplicate ring ids', () => {
    const { errors } = parseContentUpdateSettings(
      JSON.stringify({
        ring_assignment_settings: [
          { id: 'sensor_operations', ring_assignment: 'ga' },
          { id: 'sensor_operations', ring_assignment: 'ea' },
        ],
      }),
    )
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('rejects a non-string delay_hours', () => {
    const { errors } = parseContentUpdateSettings(
      JSON.stringify({ ring_assignment_settings: [{ id: 'sensor_operations', ring_assignment: 'ga', delay_hours: 4 }] }),
    )
    expect(errors.some((e) => e.includes('delay_hours'))).toBe(true)
  })

  it('returns undefined settings for empty input', () => {
    expect(parseContentUpdateSettings(undefined)).toEqual({ settings: undefined, errors: [] })
  })
})

describe('extractContentUpdatePolicySpecs', () => {
  it('parses host groups from comma-separated tags', () => {
    const specs = extractContentUpdatePolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'content-update-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'p1', hostGroups: 'g1, g2' } }],
      snapshot: {},
    })
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
    expect(specs[0].name).toBe('p1')
    expect(specs[0].enabled).toBe(false)
  })
})
