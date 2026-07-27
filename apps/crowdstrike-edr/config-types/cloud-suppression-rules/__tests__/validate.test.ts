import validate, {
  extractSuppressionSpecs,
  hasRuleSelection,
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
    configTypeId: 'cloud-suppression-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-suppression-rules',
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
    name: 'Suppress dev S3 findings',
    description: 'Accepted risk in the dev account',
    ruleSelectionType: 'all',
    ruleSeverities: 'Low, Medium',
    ruleProviders: 'aws',
    scopeType: 'account',
    accountIds: 'acct-123',
    suppressionReason: 'accepted risk',
    enabled: true,
    ...overrides,
  }
}

describe('CrowdStrike Cloud Suppression Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid suppression rule configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a rule that selects nothing to suppress', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({ ruleSeverities: '', ruleProviders: '', ruleServices: '', ruleIds: '' }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'empty_selection')).toBe(true)
  })

  it('rejects an unknown scope type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ scopeType: 'galaxy' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scope_type')).toBe(true)
  })

  it('rejects an unknown rule selection type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ ruleSelectionType: 'some' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_selection_type')).toBe(true)
  })

  it('rejects a malformed expiration', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ expiration: '2026-12-31' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('warns when the expiration is in the past', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ expiration: '2000-01-01T00:00:00Z' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'expired')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields({ name: 'suppress DEV s3 findings' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_suppression')).toBe(true)
  })
})

describe('extractSuppressionSpecs', () => {
  it('title-cases severities, lowercases providers, and defaults enabled true', () => {
    const sections = [
      {
        name: 'sec1',
        fields: {
          name: 'r1',
          ruleSeverities: 'critical, high',
          ruleProviders: 'AWS, Azure',
          accountIds: 'a1, a2',
        },
      },
    ]
    const specs = extractSuppressionSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-suppression-rules',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].ruleSeverities).toEqual(['Critical', 'High'])
    expect(specs[0].ruleProviders).toEqual(['aws', 'azure'])
    expect(specs[0].accountIds).toEqual(['a1', 'a2'])
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].ruleSelectionType).toBe('all')
    expect(specs[0].scopeType).toBe('account')
  })

  it('reports whether a rule selects anything to suppress', () => {
    const base = {
      sectionName: 's',
      name: 'r',
      ruleSelectionType: 'all',
      ruleSeverities: [] as string[],
      ruleProviders: [] as string[],
      ruleServices: [] as string[],
      ruleIds: [] as string[],
      scopeType: 'account',
      accountIds: [] as string[],
      cloudProviders: [] as string[],
      regions: [] as string[],
      resourceTypes: [] as string[],
      enabled: true,
    }
    expect(hasRuleSelection(base)).toBe(false)
    expect(hasRuleSelection({ ...base, ruleSeverities: ['High'] })).toBe(true)
  })
})
