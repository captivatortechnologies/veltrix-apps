import validate, { parseResponseSettings, extractPolicySpecs, flattenLiveSettings } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'response-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'response-policies',
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
    name: 'Responders RTR',
    platform: 'Windows',
    enabled: true,
    hostGroups: 'group-id-1',
    settings: JSON.stringify([
      { id: 'RealTimeResponse', value: { enabled: true } },
      { id: 'RealTimeResponseActiveResponder', value: { enabled: true } },
    ]),
    ...overrides,
  }
}

describe('CrowdStrike Response Policies Validate Handler', () => {
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

  it('rejects unknown platforms', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ platform: 'Solaris' }) }]),
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

  it('rejects ML-slider settings that belong to prevention policies', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validPolicyFields({
            settings: JSON.stringify([
              { id: 'CloudAntiMalware', value: { detection: 'MODERATE', prevention: 'MODERATE' } },
            ]),
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
        { name: 'sec2', fields: validPolicyFields({ platform: 'Linux' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('parseResponseSettings', () => {
  it('accepts capability toggle settings', () => {
    const { settings, errors } = parseResponseSettings(
      JSON.stringify([
        { id: 'RealTimeResponse', value: { enabled: true } },
        { id: 'RealTimeResponseAdmin', value: { enabled: false } },
      ]),
    )
    expect(errors).toHaveLength(0)
    expect(settings).toHaveLength(2)
  })

  it('rejects ML-slider values (prevention-style settings)', () => {
    const { errors } = parseResponseSettings(
      JSON.stringify([{ id: 'CloudAntiMalware', value: { detection: 'MODERATE' } }]),
    )
    expect(errors.some((e) => e.includes('toggles'))).toBe(true)
  })

  it('rejects a value missing the enabled key', () => {
    const { errors } = parseResponseSettings(
      JSON.stringify([{ id: 'RealTimeResponse', value: {} }]),
    )
    expect(errors.some((e) => e.includes('toggle'))).toBe(true)
  })

  it('rejects non-boolean toggles', () => {
    const { errors } = parseResponseSettings(
      JSON.stringify([{ id: 'RealTimeResponse', value: { enabled: 'yes' } }]),
    )
    expect(errors.some((e) => e.includes('true or false'))).toBe(true)
  })

  it('rejects duplicate setting ids', () => {
    const { errors } = parseResponseSettings(
      JSON.stringify([
        { id: 'RealTimeResponse', value: { enabled: true } },
        { id: 'RealTimeResponse', value: { enabled: false } },
      ]),
    )
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('returns empty settings for empty input', () => {
    expect(parseResponseSettings(undefined)).toEqual({ settings: [], errors: [] })
  })
})

describe('flattenLiveSettings', () => {
  it('flattens the flat settings array into id/value pairs', () => {
    const flat = flattenLiveSettings({
      settings: [
        { id: 'RealTimeResponse', name: 'Real Time Response', value: { enabled: true } },
        { id: 'RealTimeResponseActiveResponder', name: 'Active Responder', value: { enabled: false } },
      ],
    })
    expect(flat).toEqual([
      { id: 'RealTimeResponse', value: { enabled: true } },
      { id: 'RealTimeResponseActiveResponder', value: { enabled: false } },
    ])
  })

  it('returns no settings when the live policy has none', () => {
    expect(flattenLiveSettings({})).toEqual([])
  })
})

describe('extractPolicySpecs', () => {
  it('parses host groups from comma-separated tags', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'response-policies',
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
