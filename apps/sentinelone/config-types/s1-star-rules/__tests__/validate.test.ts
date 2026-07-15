import validate, { extractStarRuleSpecs, ruleKey, isRuleActive } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-star-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-star-rules',
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

const validFields = {
  name: 'Suspicious PowerShell',
  s1ql: 'EventType = "Process Creation" AND ProcessName ContainsCIS "powershell"',
  query_type: 'events',
  severity: 'High',
}

describe('SentinelOne STAR Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing name + s1ql', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { severity: 'Low' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('s1ql'))).toBe(true)
  })

  it('rejects an unsupported query type and severity', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, query_type: 'files', severity: 'Critical' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_query_type')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('requires an expiration when the mode is Temporary', async () => {
    const missing = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, expiration_mode: 'Temporary' } }]),
    )
    expect(missing.valid).toBe(false)
    expect(missing.errors.some((e) => e.code === 'required' && e.field.includes('expiration'))).toBe(true)

    const provided = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, expiration_mode: 'Temporary', expiration: '2026-12-31T23:59:59Z' } }]),
    )
    expect(provided.valid).toBe(true)
  })

  it('rejects an unsupported expiration mode', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, expiration_mode: 'Never' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_expiration_mode')).toBe(true)
  })

  it('rejects duplicate rule names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Beacon Rule' } },
        { name: 'b', fields: { ...validFields, name: 'beacon rule' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extractStarRuleSpecs defaults, trims and reads booleans', () => {
    const specs = extractStarRuleSpecs(
      makeCtx([{ name: 'e', fields: { name: '  Rule X  ', s1ql: '  q  ', network_quarantine: true } }]).canvas,
    )
    expect(specs[0].name).toBe('Rule X')
    expect(specs[0].s1ql).toBe('q')
    expect(specs[0].queryType).toBe('events')
    expect(specs[0].severity).toBe('Medium')
    expect(specs[0].activate).toBe(true)
    expect(specs[0].treatAsThreat).toBe('none')
    expect(specs[0].networkQuarantine).toBe(true)
    expect(specs[0].expirationMode).toBe('Permanent')
    expect(ruleKey('  Rule X ')).toBe('rule x')
  })

  it('isRuleActive treats only "Active" (any case) as enabled', () => {
    expect(isRuleActive('Active')).toBe(true)
    expect(isRuleActive('active')).toBe(true)
    expect(isRuleActive('Draft')).toBe(false)
    expect(isRuleActive(undefined)).toBe(false)
  })
})
