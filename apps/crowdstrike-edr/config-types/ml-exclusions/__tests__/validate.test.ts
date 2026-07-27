import validate, { extractMlExclusionSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'ml-exclusions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'ml-exclusions',
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

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    value: '/opt/app/**',
    excludedFrom: 'blocking',
    appliedGlobally: false,
    hostGroups: 'group-id-1',
    comment: 'App noise',
    ...overrides,
  }
}

describe('CrowdStrike ML Exclusions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid exclusion configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing value', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ value: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown excluded-from source', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ excludedFrom: 'blocking, quarantine' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_excluded_from')).toBe(true)
  })

  it('accepts both blocking and extraction sources', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ excludedFrom: 'blocking, extraction' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires host groups when not applied globally', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ appliedGlobally: false, hostGroups: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('allows a globally-applied exclusion with no host groups', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ appliedGlobally: true, hostGroups: '' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when host groups are set alongside apply-globally', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ appliedGlobally: true, hostGroups: 'g1' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'host_groups_ignored')).toBe(true)
  })

  it('rejects duplicate values', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_exclusion')).toBe(true)
  })
})

describe('extractMlExclusionSpecs', () => {
  it('defaults excludedFrom to blocking and parses host groups', () => {
    const sections = [{ name: 'sec1', fields: { value: '/tmp/x', hostGroups: 'g1, g2' } }]
    const specs = extractMlExclusionSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'ml-exclusions',
      items: sections,
      sections,
      snapshot: {},
    })
    expect(specs[0].excludedFrom).toEqual(['blocking'])
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
    expect(specs[0].appliedGlobally).toBe(false)
  })
})
