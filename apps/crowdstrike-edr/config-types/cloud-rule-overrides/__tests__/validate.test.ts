import validate, { extractOverrideSpecs, overrideKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'cloud-rule-overrides',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-rule-overrides',
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
    ruleId: 'rule-abc-123',
    overrideType: 'exception',
    reason: 'accepted risk',
    crn: 'crn:aws:acct:123',
    ...overrides,
  }
}

describe('CrowdStrike Cloud Rule Overrides Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid override configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing rule id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ ruleId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('warns on an unverified override type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ overrideType: 'severity' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unverified_override_type')).toBe(true)
  })

  it('rejects a malformed expiration', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ expiresAt: 'next tuesday' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects duplicate rule/scope overrides', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_override')).toBe(true)
  })

  it('allows the same rule id on different scopes', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields({ crn: 'crn:aws:acct:456' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractOverrideSpecs', () => {
  it('defaults the override type to exception and keeps optional fields undefined', () => {
    const sections = [{ name: 'sec1', fields: { ruleId: 'r1' } }]
    const specs = extractOverrideSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-rule-overrides',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].ruleId).toBe('r1')
    expect(specs[0].overrideType).toBe('exception')
    expect(specs[0].crn).toBeUndefined()
  })

  it('keys an override by rule id, scoped by crn when present', () => {
    const base = {
      sectionName: 's',
      ruleId: 'r1',
      overrideType: 'exception',
    }
    expect(overrideKey(base)).toBe('r1')
    expect(overrideKey({ ...base, crn: 'crn:aws:1' })).toBe('r1|crn:aws:1')
  })
})
