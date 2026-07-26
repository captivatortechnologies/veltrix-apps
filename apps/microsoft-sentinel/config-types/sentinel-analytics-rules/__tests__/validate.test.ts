import validate, { extractRuleSpecs, ruleKey } from '../validate'
import { buildScheduledRuleBody, buildAlertRuleBody, alertRuleApiVersion } from '../deploy'
import { SENTINEL_API_VERSION, SENTINEL_NRT_API_VERSION } from '../../../lib/sentinel'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-analytics-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-analytics-rules',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      subscription_id: '11111111-1111-1111-1111-111111111111',
      resource_group: 'rg-soc',
      workspace_name: 'ws-sentinel',
      azure_cloud: 'commercial',
    },
    platform: stubPlatform,
  }
}

const validRule = {
  rule_name: 'Suspicious sign-ins',
  enabled: true,
  severity: 'High',
  query: 'SigninLogs | where ResultType != 0',
  query_frequency: 'PT1H',
  query_period: 'PT1H',
  trigger_operator: 'GreaterThan',
  trigger_threshold: 0,
  suppression_duration: 'PT1H',
  suppression_enabled: false,
  tactics: ['InitialAccess'],
}

const validNrtRule = {
  rule_name: 'NRT privileged role added',
  kind: 'NRT',
  enabled: true,
  severity: 'High',
  query: 'AuditLogs | where OperationName == "Add member to role"',
  suppression_duration: 'PT1H',
  suppression_enabled: false,
  tactics: ['PrivilegeEscalation'],
}

describe('Sentinel Analytics Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete scheduled rule', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a rule name and a query', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, rule_name: '', query: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.rule_name') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.query') && e.code === 'required')).toBe(true)
  })

  it('rejects a non ISO-8601 query frequency', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, query_frequency: '1 hour' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('rejects an invalid severity and trigger operator', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, severity: 'Critical', trigger_operator: 'Above' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_operator')).toBe(true)
  })

  it('rejects tactics that are not AttackTactic enum values', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, tactics: ['InitialAccess', 'NotATactic'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_tactic')).toBe(true)
  })

  it('rejects duplicate rule names that slug to the same id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validRule, rule_name: 'Suspicious sign-ins' } },
        { name: 'b', fields: { ...validRule, rule_name: 'Suspicious   Sign-Ins' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extract derives a deterministic ruleId slug and reads fields', () => {
    const specs = extractRuleSpecs(makeCtx([{ name: 'r', fields: { ...validRule, rule_name: '  Suspicious Sign-Ins!  ' } }]).canvas)
    expect(specs[0].ruleName).toBe('Suspicious Sign-Ins!')
    expect(specs[0].ruleId).toBe('suspicious-sign-ins')
    expect(specs[0].tactics).toEqual(['InitialAccess'])
    expect(ruleKey('Suspicious Sign-Ins!')).toBe('suspicious-sign-ins')
  })

  it('builds a Scheduled rule body with the mapped properties', () => {
    const specs = extractRuleSpecs(makeCtx([{ name: 'r', fields: { ...validRule } }]).canvas)
    const body = buildScheduledRuleBody(specs[0]) as { kind: string; properties: Record<string, unknown> }
    expect(body.kind).toBe('Scheduled')
    expect(body.properties.displayName).toBe('Suspicious sign-ins')
    expect(body.properties.queryFrequency).toBe('PT1H')
    expect(body.properties.triggerOperator).toBe('GreaterThan')
    expect(body.properties.severity).toBe('High')
  })

  it('validates a complete NRT rule without frequency/period/trigger', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validNrtRule } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('does not require frequency/period/trigger for an NRT rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { rule_name: 'NRT rule', kind: 'NRT', severity: 'Medium', query: 'Heartbeat', suppression_duration: 'PT1H' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('still requires frequency/period/trigger for a Scheduled rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { ...validRule, kind: 'Scheduled', query_frequency: '', trigger_operator: '' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.query_frequency') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_operator')).toBe(true)
  })

  it('rejects an unknown rule kind', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, kind: 'Fusion' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_kind')).toBe(true)
  })

  it('extract normalises NRT away from Scheduled-only fields', () => {
    const specs = extractRuleSpecs(
      makeCtx([{ name: 'r', fields: { ...validNrtRule, query_frequency: 'PT1H', trigger_threshold: 5 } }]).canvas,
    )
    expect(specs[0].kind).toBe('NRT')
    expect(specs[0].queryFrequency).toBe('')
    expect(specs[0].triggerThreshold).toBe(0)
  })

  it('builds an NRT rule body without frequency/period/trigger and selects the preview api-version', () => {
    const specs = extractRuleSpecs(makeCtx([{ name: 'r', fields: { ...validNrtRule } }]).canvas)
    const body = buildAlertRuleBody(specs[0]) as { kind: string; properties: Record<string, unknown> }
    expect(body.kind).toBe('NRT')
    expect(body.properties.query).toBe('AuditLogs | where OperationName == "Add member to role"')
    expect(body.properties.queryFrequency).toBeUndefined()
    expect(body.properties.triggerOperator).toBeUndefined()
    expect(alertRuleApiVersion('NRT')).toBe(SENTINEL_NRT_API_VERSION)
    expect(alertRuleApiVersion('Scheduled')).toBe(SENTINEL_API_VERSION)
  })
})
