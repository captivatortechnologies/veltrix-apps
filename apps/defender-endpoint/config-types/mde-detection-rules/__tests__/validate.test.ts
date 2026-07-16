import validate, { extractDetectionRuleSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'defender-endpoint',
    customerId: 'cust-1',
    configTypeId: 'mde-detection-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'defender-endpoint',
      entityType: 'mde-detection-rules',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000' },
    platform: stubPlatform,
  }
}

// A complete, valid rule minus its rule_id (varied per test).
const base = {
  display_name: 'Encoded PowerShell',
  query_text: 'DeviceProcessEvents | where ProcessCommandLine has "-enc"',
  alert_title: 'Encoded PowerShell detected',
  alert_description: 'A process launched with an encoded command line.',
}

describe('Defender Detection Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed detection rule', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { rule_id: 'office-encoded-powershell', frequency: 'PT1H', status: 'enabled', alert_severity: 'medium', ...base } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires the mandatory fields', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { rule_id: 'r1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid rule_id (uppercase / underscores)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { rule_id: 'Bad_ID', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_id')).toBe(true)
  })

  it('rejects an invalid frequency', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { rule_id: 'r1', frequency: 'PT5M', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_frequency')).toBe(true)
  })

  it('rejects an invalid (non-lowercase) severity', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { rule_id: 'r1', alert_severity: 'High', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { rule_id: 'r1', status: 'paused', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects duplicate rule_id (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { rule_id: 'dup-rule', ...base } },
        { name: 'b', fields: { rule_id: 'DUP-RULE', ...base } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extract behaves (trims and applies defaults)', () => {
    const specs = extractDetectionRuleSpecs(
      makeCtx([{ name: 't', fields: { rule_id: '  office-encoded-powershell  ', display_name: '  Encoded PS  ' } }]).canvas,
    )
    expect(specs[0].ruleId).toBe('office-encoded-powershell')
    expect(specs[0].displayName).toBe('Encoded PS')
    expect(specs[0].frequency).toBe('PT1H')
    expect(specs[0].status).toBe('enabled')
    expect(specs[0].alertSeverity).toBe('medium')
  })
})
