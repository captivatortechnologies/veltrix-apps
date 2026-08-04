import validate from '../validate'
import { buildPolicyBody, extractOperationalRiskPolicySpecs, policyKey } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'jfrog-xray',
    customerId: 'cust-1',
    configTypeId: 'operational-risk-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jfrog-xray',
      entityType: 'operational-risk-policies',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function item(name: string, fields: Record<string, unknown>): CanvasItemSnapshot {
  return { name, fields: { name, rule_name: 'gate', ...fields } }
}

const validMinRiskFields = { risk_mode: 'min_risk', min_risk: 'High' }
const validCustomFields = { risk_mode: 'custom', custom_is_eol: true, custom_risk: 'High' }

describe('JFrog Xray Operational Risk Policies — validate', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a valid min-risk policy', async () => {
    const result = await validate(makeCtx([item('block-high-risk', validMinRiskFields)]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid custom-condition policy', async () => {
    const result = await validate(makeCtx([item('eol-gate', validCustomFields)]))
    expect(result.valid).toBe(true)
  })

  it('requires a policy name', async () => {
    const result = await validate(makeCtx([{ name: 'x', fields: { rule_name: 'gate', ...validMinRiskFields } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a policy name containing a slash', async () => {
    const result = await validate(makeCtx([item('bad/name', validMinRiskFields)]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NAME')).toBe(true)
  })

  it('requires a rule name', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { name: 'p1', rule_name: '', ...validMinRiskFields } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_RULE_NAME')).toBe(true)
  })

  it('rejects duplicate policy names', async () => {
    const result = await validate(makeCtx([item('dup', validMinRiskFields), item('dup', validMinRiskFields)]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('rejects an unsupported risk mode', async () => {
    const result = await validate(makeCtx([item('p1', { risk_mode: 'exotic' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RISK_MODE')).toBe(true)
  })

  it('rejects an unsupported min_risk value', async () => {
    const result = await validate(makeCtx([item('p1', { risk_mode: 'min_risk', min_risk: 'Extreme' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_MIN_RISK')).toBe(true)
  })

  it('rejects custom mode with no condition set', async () => {
    const result = await validate(makeCtx([item('p1', { risk_mode: 'custom', custom_risk: 'High' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_CUSTOM_CONDITION')).toBe(true)
  })

  it('rejects custom mode with an invalid resulting risk', async () => {
    const result = await validate(makeCtx([item('p1', { risk_mode: 'custom', custom_is_eol: true, custom_risk: 'Extreme' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_CUSTOM_RISK')).toBe(true)
  })

  it('rejects an out-of-range release age', async () => {
    const result = await validate(makeCtx([item('p1', { risk_mode: 'custom', custom_release_date_months: 1000, custom_risk: 'Medium' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RELEASE_AGE')).toBe(true)
  })

  it('rejects a negative build failure grace period', async () => {
    const result = await validate(makeCtx([item('p1', { ...validMinRiskFields, fail_build: true, build_failure_grace_period_days: -1 })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_GRACE_PERIOD')).toBe(true)
  })

  it('rejects a malformed notification email', async () => {
    const result = await validate(makeCtx([item('p1', { ...validMinRiskFields, mails: ['not-an-email'] })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_EMAIL')).toBe(true)
  })

  it('rejects invalid criteria_json / actions_json', async () => {
    const result = await validate(makeCtx([item('p1', { ...validMinRiskFields, criteria_json: '{bad', actions_json: '["not", "an", "object"]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'INVALID_JSON')).toHaveLength(2)
  })

  it('rejects a malformed additional_rules_json entry', async () => {
    const result = await validate(makeCtx([item('p1', { ...validMinRiskFields, additional_rules_json: '[{"criteria":{}}]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RULE')).toBe(true)
  })
})

describe('JFrog Xray Operational Risk Policies — _shared helpers', () => {
  it('extractOperationalRiskPolicySpecs reads and trims canvas fields', () => {
    const specs = extractOperationalRiskPolicySpecs(
      makeCtx([{ name: 'e', fields: { name: '  eol-gate  ', rule_name: '  gate  ', risk_mode: 'custom', custom_is_eol: true } }]).canvas,
    )
    expect(specs[0].name).toBe('eol-gate')
    expect(specs[0].ruleName).toBe('gate')
    expect(specs[0].riskMode).toBe('custom')
    expect(specs[0].customIsEol).toBe(true)
  })

  it('policyKey trims but preserves case (Xray names are case-sensitive)', () => {
    expect(policyKey('  Block-High-Risk  ')).toBe('Block-High-Risk')
  })

  it('buildPolicyBody produces the full POST/PUT payload shape with type "operational_risk" (min_risk mode)', () => {
    const specs = extractOperationalRiskPolicySpecs(
      makeCtx([item('block-high-risk', { ...validMinRiskFields, description: 'Blocks high operational-risk components', fail_build: true })]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.name).toBe('block-high-risk')
    expect(body.type).toBe('operational_risk')
    expect(body.description).toBe('Blocks high operational-risk components')
    expect(body.rules).toHaveLength(1)
    expect(body.rules[0].name).toBe('gate')
    expect(body.rules[0].criteria.op_risk_min_risk).toBe('High')
    expect(body.rules[0].criteria.op_risk_custom).toBeUndefined()
    expect(body.rules[0].actions.fail_build).toBe(true)
  })

  it('buildPolicyBody builds the op_risk_custom nested object in custom mode', () => {
    const specs = extractOperationalRiskPolicySpecs(
      makeCtx([
        item('eol-gate', {
          risk_mode: 'custom',
          custom_use_and_condition: false,
          custom_is_eol: true,
          custom_release_date_months: 24,
          custom_commits_less_than: 10,
          custom_risk: 'High',
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.rules[0].criteria.op_risk_min_risk).toBeUndefined()
    expect(body.rules[0].criteria.op_risk_custom).toEqual({
      use_and_condition: false,
      is_eol: true,
      release_date_greater_than_months: 24,
      commits_less_than: 10,
      risk: 'High',
    })
  })

  it('buildPolicyBody merges additional_rules_json after the primary rule', () => {
    const specs = extractOperationalRiskPolicySpecs(
      makeCtx([
        item('tiered', {
          ...validMinRiskFields,
          fail_build: true,
          additional_rules_json: JSON.stringify([{ name: 'notify-only', criteria: { op_risk_min_risk: 'Medium' }, actions: { notify_watch_recipients: true } }]),
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.rules).toHaveLength(2)
    expect(body.rules[1].name).toBe('notify-only')
    expect(body.rules[1].criteria.op_risk_min_risk).toBe('Medium')
  })

  it('buildPolicyBody lets typed fields win over a colliding criteria_json/actions_json key', () => {
    const specs = extractOperationalRiskPolicySpecs(
      makeCtx([
        item('override', {
          ...validMinRiskFields,
          fail_build: true,
          criteria_json: JSON.stringify({ op_risk_min_risk: 'Low' }),
          actions_json: JSON.stringify({ fail_build: false, custom_severity: 'High' }),
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.rules[0].criteria.op_risk_min_risk).toBe('High')
    expect(body.rules[0].actions.fail_build).toBe(true)
    expect(body.rules[0].actions.custom_severity).toBe('High')
  })
})
