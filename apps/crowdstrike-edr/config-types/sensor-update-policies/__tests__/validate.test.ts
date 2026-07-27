import validate, {
  buildSensorSettings,
  extractPolicySpecs,
  readSensorSettings,
  type PolicySpec,
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
    configTypeId: 'sensor-update-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'sensor-update-policies',
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
    build: 'n-1|tagged',
    uninstall_protection: 'ENABLED',
    ...overrides,
  }
}

describe('CrowdStrike Sensor Update Policies Validate Handler', () => {
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
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ platform: 'linux' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an unknown uninstall protection mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ uninstall_protection: 'PARANOID' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_uninstall_protection')).toBe(true)
  })

  it('normalizes uninstall protection casing', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPolicyFields({ uninstall_protection: 'maintenance_mode' }) },
      ]),
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

  it('warns when no sensor build is specified', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ build: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_build')).toBe(true)
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

describe('buildSensorSettings', () => {
  const baseSpec: PolicySpec = {
    sectionName: 'sec1',
    name: 'p1',
    platform: 'Windows',
    enabled: true,
    hostGroups: [],
    build: 'n-1|tagged',
    uninstallProtection: 'ENABLED',
  }

  it('includes build and uninstall_protection when a build is set', () => {
    expect(buildSensorSettings(baseSpec)).toEqual({
      uninstall_protection: 'ENABLED',
      build: 'n-1|tagged',
    })
  })

  it('omits build when the spec has no build', () => {
    expect(buildSensorSettings({ ...baseSpec, build: undefined })).toEqual({
      uninstall_protection: 'ENABLED',
    })
  })
})

describe('readSensorSettings', () => {
  it('reads build and uninstall_protection from a live settings object', () => {
    const settings = readSensorSettings({
      settings: { build: '20008|n-1|tagged|1', uninstall_protection: 'ENABLED', scheduler: {} },
    })
    expect(settings).toEqual({ build: '20008|n-1|tagged|1', uninstall_protection: 'ENABLED' })
  })

  it('returns an empty object when settings are missing', () => {
    expect(readSensorSettings({})).toEqual({})
  })

  it('returns an empty object when settings is not an object', () => {
    expect(readSensorSettings({ settings: [] })).toEqual({})
  })
})

describe('extractPolicySpecs', () => {
  it('parses host groups, build, uninstall protection, and platform casing', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'sensor-update-policies',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: 'p1',
            platform: 'Mac',
            hostGroups: 'g1, g2',
            build: 'n-2|tagged',
            uninstall_protection: 'enabled',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
    expect(specs[0].platform).toBe('Mac')
    expect(specs[0].build).toBe('n-2|tagged')
    expect(specs[0].uninstallProtection).toBe('ENABLED')
    expect(specs[0].enabled).toBe(false)
  })

  it('defaults uninstall protection to DISABLED when omitted', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'sensor-update-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'p1', platform: 'Windows' } }],
      snapshot: {},
    })
    expect(specs[0].uninstallProtection).toBe('DISABLED')
    expect(specs[0].build).toBeUndefined()
  })
})
