import validate, {
  extractITPolicySpecs,
  parsePolicyConfig,
  flattenConfig,
  readLiveHostGroups,
  readLiveEnabled,
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
    configTypeId: 'it-automation-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'it-automation-policies',
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
    name: 'Standard IT Automation',
    platform: 'Windows',
    enabled: true,
    hostGroups: 'group-id-1',
    executionConfig: JSON.stringify({
      execution: { enable_os_query: true, execution_timeout: 4, execution_timeout_unit: 'Hours' },
      concurrency: { concurrent_host_limit: 500 },
    }),
    ...overrides,
  }
}

describe('CrowdStrike IT Automation Policies Validate Handler', () => {
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
    const result = await validate(makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a policy name over 100 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ name: 'x'.repeat(101) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
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

  it('rejects invalid execution config JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPolicyFields({ executionConfig: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('rejects a wrongly typed config field', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validPolicyFields({
            executionConfig: JSON.stringify({ execution: { execution_timeout: 'soon' } }),
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('rejects an unknown execution timeout unit', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validPolicyFields({
            executionConfig: JSON.stringify({ execution: { execution_timeout_unit: 'Days' } }),
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('warns on an unknown config key but stays valid', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validPolicyFields({
            executionConfig: JSON.stringify({ execution: { mystery_flag: true } }),
          }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unknown_config_key')).toBe(true)
  })

  it('rejects a cpu_throttle outside 0-100', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validPolicyFields({
            executionConfig: JSON.stringify({ resources: { cpu_throttle: 250 } }),
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
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

describe('parsePolicyConfig', () => {
  it('keeps only declared known keys', () => {
    const { config, errors } = parsePolicyConfig(
      JSON.stringify({ concurrency: { concurrent_task_limit: 5 } }),
    )
    expect(errors).toHaveLength(0)
    expect(config).toEqual({ concurrency: { concurrent_task_limit: 5 } })
  })

  it('returns empty config for empty input', () => {
    expect(parsePolicyConfig('')).toEqual({ errors: [], warnings: [] })
  })

  it('warns on an unknown top-level block', () => {
    const { warnings } = parsePolicyConfig(JSON.stringify({ mystery: { a: 1 } }))
    expect(warnings.some((w) => w.includes('Unknown config block'))).toBe(true)
  })
})

describe('flattenConfig', () => {
  it('flattens nested config into dot paths', () => {
    const flat = flattenConfig({ execution: { enable_os_query: true }, resources: { cpu_throttle: 25 } })
    expect(flat.get('execution.enable_os_query')).toBe('true')
    expect(flat.get('resources.cpu_throttle')).toBe('25')
  })

  it('returns an empty map for undefined', () => {
    expect(flattenConfig(undefined).size).toBe(0)
  })
})

describe('readLiveHostGroups / readLiveEnabled', () => {
  it('reads host groups from host_group_ids strings', () => {
    expect(readLiveHostGroups({ host_group_ids: ['g1', 'g2'] })).toEqual(['g1', 'g2'])
  })

  it('reads host groups from host_groups objects', () => {
    expect(readLiveHostGroups({ host_groups: [{ id: 'g3' }] })).toEqual(['g3'])
  })

  it('returns undefined when no host-group field is present', () => {
    expect(readLiveHostGroups({})).toBeUndefined()
  })

  it('reads is_enabled preferentially, then enabled', () => {
    expect(readLiveEnabled({ is_enabled: true })).toBe(true)
    expect(readLiveEnabled({ enabled: false })).toBe(false)
    expect(readLiveEnabled({})).toBeUndefined()
  })
})

describe('extractITPolicySpecs', () => {
  it('parses host groups and enablement from a section', () => {
    const specs = extractITPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'it-automation-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'p1', platform: 'Mac', hostGroups: 'g1, g2' } }],
      snapshot: {},
    })
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
    expect(specs[0].platform).toBe('Mac')
    expect(specs[0].enabled).toBe(false)
  })
})
