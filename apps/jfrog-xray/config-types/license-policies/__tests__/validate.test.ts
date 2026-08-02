import validate from '../validate'
import { buildPolicyBody, extractLicensePolicySpecs, policyKey } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'jfrog-xray',
    customerId: 'cust-1',
    configTypeId: 'license-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jfrog-xray',
      entityType: 'license-policies',
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

const validFields = { banned_licenses: ['GPL-3.0-only'] }

describe('JFrog Xray License Policies — validate', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a valid banned-license policy', async () => {
    const result = await validate(makeCtx([item('ban-gpl', validFields)]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid allowed-license policy', async () => {
    const result = await validate(makeCtx([item('allow-permissive', { allowed_licenses: ['MIT', 'Apache-2.0'] })]))
    expect(result.valid).toBe(true)
  })

  it('validates allow_unknown alone as sufficient criteria', async () => {
    const result = await validate(makeCtx([item('flag-unknown', { allow_unknown: true })]))
    expect(result.valid).toBe(true)
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

  it('rejects a policy with no license criteria at all', async () => {
    const result = await validate(makeCtx([item('empty', {})]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_CRITERIA')).toBe(true)
  })

  it('accepts empty typed criteria when criteria_json supplies a criterion', async () => {
    const result = await validate(makeCtx([item('json-only', { criteria_json: '{"allowed_licenses":["MIT"]}' })]))
    expect(result.valid).toBe(true)
  })

  it('rejects a negative build failure grace period', async () => {
    const result = await validate(makeCtx([item('p1', { ...validFields, fail_build: true, build_failure_grace_period_days: -1 })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_GRACE_PERIOD')).toBe(true)
  })

  it('warns when a grace period is set without fail_build', async () => {
    const result = await validate(makeCtx([item('p1', { ...validFields, fail_build: false, build_failure_grace_period_days: 3 })]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'GRACE_PERIOD_WITHOUT_FAIL_BUILD')).toBe(true)
  })

  it('rejects a malformed notification email', async () => {
    const result = await validate(makeCtx([item('p1', { ...validFields, mails: ['not-an-email'] })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_EMAIL')).toBe(true)
  })

  it('rejects invalid criteria_json / actions_json', async () => {
    const result = await validate(makeCtx([item('p1', { ...validFields, criteria_json: '{bad', actions_json: '["not", "an", "object"]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'INVALID_JSON')).toHaveLength(2)
  })

  it('rejects a malformed additional_rules_json entry', async () => {
    const result = await validate(makeCtx([item('p1', { ...validFields, additional_rules_json: '[{"criteria":{}}]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RULE')).toBe(true)
  })
})

describe('JFrog Xray License Policies — _shared helpers', () => {
  it('extractLicensePolicySpecs reads and trims canvas fields', () => {
    const specs = extractLicensePolicySpecs(
      makeCtx([{ name: 'e', fields: { name: '  ban-gpl  ', rule_name: '  gate  ', banned_licenses: ['GPL-3.0-only'], fail_build: true } }]).canvas,
    )
    expect(specs[0].name).toBe('ban-gpl')
    expect(specs[0].ruleName).toBe('gate')
    expect(specs[0].bannedLicenses).toEqual(['GPL-3.0-only'])
    expect(specs[0].failBuild).toBe(true)
  })

  it('policyKey trims but preserves case (Xray names are case-sensitive)', () => {
    expect(policyKey('  Ban-GPL  ')).toBe('Ban-GPL')
  })

  it('buildPolicyBody produces the full POST/PUT payload shape with type "license"', () => {
    const specs = extractLicensePolicySpecs(
      makeCtx([
        item('ban-gpl', {
          description: 'Blocks copyleft licenses',
          banned_licenses: ['GPL-3.0-only', 'AGPL-3.0-only'],
          fail_build: true,
          mails: ['secops@example.com'],
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.name).toBe('ban-gpl')
    expect(body.type).toBe('license')
    expect(body.description).toBe('Blocks copyleft licenses')
    expect(body.rules).toHaveLength(1)
    expect(body.rules[0].name).toBe('gate')
    expect(body.rules[0].criteria.banned_licenses).toEqual(['GPL-3.0-only', 'AGPL-3.0-only'])
    expect(body.rules[0].actions.fail_build).toBe(true)
    expect(body.rules[0].actions.mails).toEqual(['secops@example.com'])
  })

  it('buildPolicyBody sets allow_unknown and multi_license_permissive', () => {
    const specs = extractLicensePolicySpecs(makeCtx([item('permissive', { allow_unknown: true, multi_license_permissive: true })]).canvas)
    const body = buildPolicyBody(specs[0])
    expect(body.rules[0].criteria.allow_unknown).toBe(true)
    expect(body.rules[0].criteria.multi_license_permissive).toBe(true)
  })

  it('buildPolicyBody merges additional_rules_json after the primary rule', () => {
    const specs = extractLicensePolicySpecs(
      makeCtx([
        item('tiered', {
          banned_licenses: ['GPL-3.0-only'],
          fail_build: true,
          additional_rules_json: JSON.stringify([{ name: 'notify-only', criteria: { allow_unknown: true }, actions: { notify_watch_recipients: true } }]),
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.rules).toHaveLength(2)
    expect(body.rules[1].name).toBe('notify-only')
    expect(body.rules[1].criteria.allow_unknown).toBe(true)
  })

  it('buildPolicyBody lets typed fields win over a colliding criteria_json/actions_json key', () => {
    const specs = extractLicensePolicySpecs(
      makeCtx([
        item('override', {
          banned_licenses: ['GPL-3.0-only'],
          fail_build: true,
          criteria_json: JSON.stringify({ banned_licenses: ['MIT'] }),
          actions_json: JSON.stringify({ fail_build: false, custom_severity: 'High' }),
        }),
      ]).canvas,
    )
    const body = buildPolicyBody(specs[0])
    expect(body.rules[0].criteria.banned_licenses).toEqual(['GPL-3.0-only'])
    expect(body.rules[0].actions.fail_build).toBe(true)
    expect(body.rules[0].actions.custom_severity).toBe('High')
  })
})
