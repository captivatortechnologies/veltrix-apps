import validate, { parsePolicySettings, extractPolicySpecs, flattenLiveSettings } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'prevention-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'prevention-policies',
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
    name: 'Production Workstations',
    platform: 'Windows',
    enabled: true,
    hostGroups: 'group-id-1',
    settings: JSON.stringify([
      { id: 'NextGenAV', value: { enabled: true } },
      { id: 'CloudAntiMalware', value: { detection: 'MODERATE', prevention: 'MODERATE' } },
    ]),
    ...overrides,
  }
}

describe('CrowdStrike Prevention Policies Validate Handler', () => {
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

describe('parsePolicySettings', () => {
  it('accepts toggle and slider settings', () => {
    const { settings, errors } = parsePolicySettings(
      JSON.stringify([
        { id: 'NextGenAV', value: { enabled: true } },
        { id: 'OnSensorMLSlider', value: { detection: 'AGGRESSIVE', prevention: 'MODERATE' } },
      ]),
    )
    expect(errors).toHaveLength(0)
    expect(settings).toHaveLength(2)
  })

  it('rejects a prevention level more aggressive than detection', () => {
    const { errors } = parsePolicySettings(
      JSON.stringify([
        { id: 'CloudAntiMalware', value: { detection: 'CAUTIOUS', prevention: 'AGGRESSIVE' } },
      ]),
    )
    expect(errors.some((e) => e.includes('more aggressive'))).toBe(true)
  })

  it('rejects unknown slider levels', () => {
    const { errors } = parsePolicySettings(
      JSON.stringify([{ id: 'CloudAntiMalware', value: { detection: 'MAXIMUM' } }]),
    )
    expect(errors.some((e) => e.includes('must be one of'))).toBe(true)
  })

  it('rejects non-boolean toggles', () => {
    const { errors } = parsePolicySettings(
      JSON.stringify([{ id: 'NextGenAV', value: { enabled: 'yes' } }]),
    )
    expect(errors.some((e) => e.includes('true or false'))).toBe(true)
  })

  it('rejects duplicate setting ids', () => {
    const { errors } = parsePolicySettings(
      JSON.stringify([
        { id: 'NextGenAV', value: { enabled: true } },
        { id: 'NextGenAV', value: { enabled: false } },
      ]),
    )
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('returns empty settings for empty input', () => {
    expect(parsePolicySettings(undefined)).toEqual({ settings: [], errors: [] })
  })
})

describe('flattenLiveSettings', () => {
  it('flattens categorized prevention_settings into id/value pairs', () => {
    const flat = flattenLiveSettings({
      prevention_settings: [
        {
          name: 'Enhanced Visibility',
          settings: [
            { id: 'NextGenAV', name: 'Next-Gen AV', type: 'toggle', value: { enabled: true } },
          ],
        },
        {
          name: 'Cloud Machine Learning',
          settings: [
            {
              id: 'CloudAntiMalware',
              name: 'Cloud Anti-malware',
              type: 'mlslider',
              value: { detection: 'MODERATE', prevention: 'CAUTIOUS' },
            },
          ],
        },
      ],
    })
    expect(flat).toEqual([
      { id: 'NextGenAV', value: { enabled: true } },
      { id: 'CloudAntiMalware', value: { detection: 'MODERATE', prevention: 'CAUTIOUS' } },
    ])
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
      entityType: 'prevention-policies',
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
