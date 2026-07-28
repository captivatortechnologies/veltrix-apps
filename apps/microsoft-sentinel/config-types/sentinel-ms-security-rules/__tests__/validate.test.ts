import validate, { extractMsSecuritySpecs, ruleKey, readList } from '../validate'
import { buildMsSecurityRuleBody, MS_SECURITY_KIND } from '../deploy'
import { SENTINEL_API_VERSION } from '../../../lib/sentinel'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-ms-security-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-ms-security-rules',
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
  rule_name: 'Defender for Cloud Apps incidents',
  enabled: true,
  product_filter: 'Microsoft Cloud App Security',
  description: 'Create incidents from Defender for Cloud Apps alerts',
  severities_filter: ['High', 'Medium'],
  display_names_filter: ['Impossible travel'],
  display_names_exclude_filter: [],
}

describe('Sentinel Microsoft Security Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete rule', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a rule name', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, rule_name: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.rule_name') && e.code === 'required')).toBe(true)
  })

  it('requires a product filter', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, product_filter: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.product_filter') && e.code === 'required')).toBe(true)
  })

  it('rejects a product filter outside the service enum', async () => {
    // "Microsoft Defender Advanced Threat Protection" is NOT a MicrosoftSecurityProductName value.
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, product_filter: 'Microsoft Defender Advanced Threat Protection' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_product')).toBe(true)
  })

  it('rejects a severity outside the allowed set', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, severities_filter: ['High', 'Critical'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('accepts a rule with no optional filters', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { rule_name: 'All Defender for Cloud alerts', product_filter: 'Azure Security Center' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects duplicate rule names that slug to the same id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validRule, rule_name: 'MDCA incidents' } },
        { name: 'b', fields: { ...validRule, rule_name: 'MDCA   Incidents' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extract derives a deterministic, namespaced ruleId and reads list fields', () => {
    const specs = extractMsSecuritySpecs(makeCtx([{ name: 'r', fields: { ...validRule, rule_name: '  Impossible Travel!  ' } }]).canvas)
    expect(specs[0].ruleName).toBe('Impossible Travel!')
    // ruleId is namespaced (prefixed) so it can't collide with an analytics rule
    // in the shared /alertRules collection; the intra-type key stays the bare slug.
    expect(specs[0].ruleId).toBe('mssecurity--impossible-travel')
    expect(specs[0].severitiesFilter).toEqual(['High', 'Medium'])
    expect(ruleKey('Impossible Travel!')).toBe('impossible-travel')
  })

  it('never produces a ruleId that could collide with an analytics-rule slug', () => {
    // slugify never emits `--`, so a `--`-containing namespaced id is disjoint from
    // any analytics rule's slug — even for an adversarially crafted name.
    const specs = extractMsSecuritySpecs(makeCtx([{ name: 'r', fields: { ...validRule, rule_name: 'mssecurity foo' } }]).canvas)
    expect(specs[0].ruleId).toBe('mssecurity--mssecurity-foo')
    expect(specs[0].ruleId.includes('--')).toBe(true)
  })

  it('reads a comma-separated list into a trimmed array', () => {
    expect(readList('High, Medium , Low')).toEqual(['High', 'Medium', 'Low'])
  })

  it('builds a MicrosoftSecurityIncidentCreation body with the mapped properties', () => {
    const specs = extractMsSecuritySpecs(makeCtx([{ name: 'r', fields: { ...validRule } }]).canvas)
    const body = buildMsSecurityRuleBody(specs[0]) as { kind: string; properties: Record<string, unknown> }
    expect(body.kind).toBe(MS_SECURITY_KIND)
    expect(body.kind).toBe('MicrosoftSecurityIncidentCreation')
    expect(body.properties.displayName).toBe('Defender for Cloud Apps incidents')
    expect(body.properties.enabled).toBe(true)
    expect(body.properties.productFilter).toBe('Microsoft Cloud App Security')
    expect(body.properties.severitiesFilter).toEqual(['High', 'Medium'])
    expect(body.properties.displayNamesFilter).toEqual(['Impossible travel'])
  })

  it('omits empty optional filters and description from the request body', () => {
    const specs = extractMsSecuritySpecs(
      makeCtx([{ name: 'r', fields: { rule_name: 'Bare rule', product_filter: 'Azure Security Center' } }]).canvas,
    )
    const body = buildMsSecurityRuleBody(specs[0]) as { kind: string; properties: Record<string, unknown> }
    expect(body.properties.productFilter).toBe('Azure Security Center')
    expect(body.properties.severitiesFilter).toBeUndefined()
    expect(body.properties.displayNamesFilter).toBeUndefined()
    expect(body.properties.displayNamesExcludeFilter).toBeUndefined()
    expect(body.properties.description).toBeUndefined()
  })

  it('uses the GA api-version for the alertRules collection', () => {
    expect(SENTINEL_API_VERSION).toBe('2024-09-01')
  })
})
