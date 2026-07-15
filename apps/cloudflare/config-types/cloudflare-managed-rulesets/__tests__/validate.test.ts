import validate, { extractManagedRulesetSpecs, slugRef, parseJsonObject } from '../validate'
import { buildRule } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-managed-rulesets',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-managed-rulesets',
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

describe('Cloudflare Managed Rulesets Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid managed ruleset deployment', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Managed Ruleset', fields: { name: 'Cloudflare Managed', managed_ruleset_id: 'efb7b8c949ac4650a09736fc376e9aee' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name and managed_ruleset_id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { enabled: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('managed_ruleset_id'))).toBe(true)
  })

  it('rejects duplicate refs (names that slug the same)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'OWASP Core', managed_ruleset_id: 'aaa' } },
        { name: 'b', fields: { name: 'owasp core', managed_ruleset_id: 'bbb' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('rejects invalid overrides_json (array, not object)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'r', managed_ruleset_id: 'aaa', overrides_json: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('accepts a valid overrides_json object', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'r', managed_ruleset_id: 'aaa', overrides_json: '{"action":"log","categories":[{"category":"wordpress","action":"block"}]}' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('buildRule fixes action=execute, defaults expression, and shapes action_parameters', () => {
    const specs = extractManagedRulesetSpecs(
      makeCtx([{ name: 'Managed Ruleset', fields: { name: 'CF Managed', managed_ruleset_id: 'efb7b8c949ac4650a09736fc376e9aee' } }]).canvas,
    )
    const rule = buildRule(specs[0])
    expect(rule.action).toBe('execute')
    expect(rule.ref).toBe('cf_managed')
    expect(rule.description).toBe('CF Managed')
    // expression defaults to "true" when blank
    expect(rule.expression).toBe('true')
    expect(rule.enabled).toBe(true)
    expect(rule.action_parameters).toEqual({ id: 'efb7b8c949ac4650a09736fc376e9aee' })

    // With overrides present, action_parameters carries them.
    const withOverrides = extractManagedRulesetSpecs(
      makeCtx([{ name: 's', fields: { name: 'x', managed_ruleset_id: 'aaa', expression: 'ip.src eq 1.1.1.1', enabled: false, overrides_json: '{"action":"log"}' } }]).canvas,
    )
    const rule2 = buildRule(withOverrides[0])
    expect(rule2.expression).toBe('ip.src eq 1.1.1.1')
    expect(rule2.enabled).toBe(false)
    expect(rule2.action_parameters).toEqual({ id: 'aaa', overrides: { action: 'log' } })
  })

  it('slugRef + parseJsonObject behave', () => {
    expect(slugRef('OWASP Core!')).toBe('owasp_core')
    expect(parseJsonObject('   ').error).toBeNull()
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 })
    expect(parseJsonObject('nope').error).toBeTruthy()
    const specs = extractManagedRulesetSpecs(makeCtx([{ name: 'r', fields: { name: '  My Ruleset  ' } }]).canvas)
    expect(specs[0].ref).toBe('my_ruleset')
    expect(specs[0].enabled).toBe(true)
  })
})
