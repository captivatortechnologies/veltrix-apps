import validate from '../validate'
import { buildPolicyBody, extractPolicySpecs, policyKey } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'jfrog-xray',
    customerId: 'cust-1',
    configTypeId: 'security-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jfrog-xray',
      entityType: 'security-policies',
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

const validFields = { min_severity: 'High', fail_build: true }

describe('JFrog Xray Security Policies — validate', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a valid severity-gate policy', async () => {
    const result = await validate(makeCtx([item('block-critical', validFields)]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a policy name', async () => {
    const result = await validate(makeCtx([{ name: 'x', fields: { rule_name: 'gate', ...validFields } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a policy name containing a slash', async () => {
    const result = await validate(makeCtx([item('bad/name', validFields)]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NAME')).toBe(true)
  })

  it('requires a rule name', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { name: 'p1', rule_name: '', ...validFields } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_RULE_NAME')).toBe(true)
  })

  it('rejects duplicate policy names', async () => {
    const result = await validate(makeCtx([item('dup', validFields), item('dup', validFields)]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('rejects an unsupported minimum severity', async () => {
    const result = await validate(makeCtx([item('p1', { min_severity: 'Extreme' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SEVERITY')).toBe(true)
  })

  it('requires both bounds of a CVSS range', async () => {
    const result = await validate(makeCtx([item('p1', { use_cvss_range: true, cvss_from: 7 })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INCOMPLETE_CVSS_RANGE')).toBe(true)
  })

  it('rejects a CVSS score outside 0-10', async () => {
    const result = await validate(makeCtx([item('p1', { use_cvss_range: true, cvss_from: -1, cvss_to: 11 })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_CVSS_SCORE')).toBe(true)
  })

  it('rejects a CVSS range where from > to', async () => {
    const result = await validate(makeCtx([item('p1', { use_cvss_range: true, cvss_from: 9, cvss_to: 3 })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_CVSS_RANGE')).toBe(true)
  })

  it('accepts a valid CVSS range', async () => {
    const result = await validate(makeCtx([item('p1', { use_cvss_range: true, cvss_from: 4, cvss_to: 10 })]))
    expect(result.valid).toBe(true)
  })

  it('rejects malicious_package combined with fix_version_dependant', async () => {
    const result = await validate(makeCtx([item('p1', { malicious_package: true, fix_version_dependant: true })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'CONFLICTING_CRITERIA')).toBe(true)
  })

  it('rejects a negative build failure grace period', async () => {
    const result = await validate(makeCtx([item('p1', { fail_build: true, build_failure_grace_period_days: -1 })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_GRACE_PERIOD')).toBe(true)
  })

  it('warns when a grace period is set without fail_build', async () => {
    const result = await validate(makeCtx([item('p1', { fail_build: false, build_failure_grace_period_days: 3 })]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'GRACE_PERIOD_WITHOUT_FAIL_BUILD')).toBe(true)
  })

  it('rejects a malformed notification email', async () => {
    const result = await validate(makeCtx([item('p1', { mails: ['not-an-email'] })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_EMAIL')).toBe(true)
  })

  it('accepts valid notification emails', async () => {
    const result = await validate(makeCtx([item('p1', { mails: ['secops@example.com'] })]))
    expect(result.valid).toBe(true)
  })

  it('rejects invalid criteria_json / actions_json', async () => {
    const result = await validate(makeCtx([item('p1', { criteria_json: '{bad', actions_json: '["not", "an", "object"]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'INVALID_JSON')).toHaveLength(2)
  })

  it('rejects a malformed additional_rules_json entry', async () => {
    const result = await validate(makeCtx([item('p1', { additional_rules_json: '[{"criteria":{}}]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RULE')).toBe(true)
  })

  it('accepts a well-formed additional_rules_json', async () => {
    const result = await validate(
      makeCtx([item('p1', { additional_rules_json: '[{"name":"notify-only","criteria":{"min_severity":"Medium"},"actions":{"notify_watch_recipients":true}}]' })]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('JFrog Xray Security Policies — _shared helpers', () => {
  it('extractPolicySpecs reads and trims canvas fields', () => {
    const specs = extractPolicySpecs(
      makeCtx([{ name: 'e', fields: { name: '  block-crit  ', rule_name: '  gate  ', min_severity: 'Critical', fail_build: true } }]).canvas,
    )
    expect(specs[0].name).toBe('block-crit')
    expect(specs[0].ruleName).toBe('gate')
    expect(specs[0].minSeverity).toBe('Critical')
    expect(specs[0].failBuild).toBe(true)
    expect(specs[0].useCvssRange).toBe(false)
  })

  it('policyKey trims but preserves case (Xray names are case-sensitive)', () => {
    expect(policyKey('  Block-Critical  ')).toBe('Block-Critical')
  })

  it('buildPolicyBody produces the full POST/PUT payload shape', () => {
    const specs = extractPolicySpecs(
      makeCtx([
        item('block-critical', {
          description: 'Blocks critical vulnerabilities',
          min_severity: 'Critical',
          fail_build: true,
          block_download_active: true,
          mails: ['secops@example.com'],
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.name).toBe('block-critical')
    expect(body.type).toBe('security')
    expect(body.description).toBe('Blocks critical vulnerabilities')
    expect(body.rules).toHaveLength(1)
    expect(body.rules[0].name).toBe('gate')
    expect(body.rules[0].criteria.min_severity).toBe('Critical')
    expect(body.rules[0].actions.fail_build).toBe(true)
    expect(body.rules[0].actions.block_download).toEqual({ active: true, unscanned: false })
    expect(body.rules[0].actions.mails).toEqual(['secops@example.com'])
  })

  it('buildPolicyBody uses a CVSS range instead of min_severity when enabled', () => {
    const specs = extractPolicySpecs(makeCtx([item('cvss-gate', { use_cvss_range: true, cvss_from: 7, cvss_to: 10 })]).canvas)
    const body = buildPolicyBody(specs[0])
    expect(body.rules[0].criteria.min_severity).toBeUndefined()
    expect(body.rules[0].criteria.cvss_range).toEqual({ from: 7, to: 10 })
  })

  it('buildPolicyBody merges additional_rules_json after the primary rule', () => {
    const specs = extractPolicySpecs(
      makeCtx([
        item('tiered', {
          min_severity: 'Critical',
          fail_build: true,
          additional_rules_json: JSON.stringify([{ name: 'notify-only', criteria: { min_severity: 'Medium' }, actions: { notify_watch_recipients: true } }]),
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.rules).toHaveLength(2)
    expect(body.rules[1].name).toBe('notify-only')
    expect(body.rules[1].criteria.min_severity).toBe('Medium')
    expect(body.rules[1].actions.notify_watch_recipients).toBe(true)
  })

  it('buildPolicyBody lets typed fields win over a colliding criteria_json/actions_json key', () => {
    const specs = extractPolicySpecs(
      makeCtx([
        item('override', {
          min_severity: 'High',
          fail_build: true,
          criteria_json: JSON.stringify({ min_severity: 'Low' }),
          actions_json: JSON.stringify({ fail_build: false, custom_severity: 'High' }),
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.rules[0].criteria.min_severity).toBe('High')
    expect(body.rules[0].actions.fail_build).toBe(true)
    expect(body.rules[0].actions.custom_severity).toBe('High')
  })
})
