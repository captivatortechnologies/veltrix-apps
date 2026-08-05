import validate, { extractFusionRuleSpecs, FUSION_ALERT_RULE_TEMPLATE_NAME, FUSION_KIND } from '../validate'
import { buildFusionRuleBody, pickFusionRule, FUSION_FALLBACK_RULE_ID, type LiveAlertRule } from '../deploy'
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
    configTypeId: 'sentinel-fusion-rule',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-fusion-rule',
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

const validItem = { label: 'Fusion (Advanced Multi-Stage Attack Detection)', enabled: true }

describe('Sentinel Fusion Rule Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a single declared Fusion item', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: { ...validItem } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects declaring the singleton more than once', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validItem } },
        { name: 'b', fields: { ...validItem, enabled: false } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_singleton')).toBe(true)
  })

  it('is still valid with a blank label — it is cosmetic only and defaults to "Fusion"', async () => {
    const result = await validate(makeCtx([{ name: 'f', fields: { ...validItem, label: '' } }]))
    expect(result.valid).toBe(true)
  })

  it('extract defaults label and enabled when the fields are absent', () => {
    const specs = extractFusionRuleSpecs(makeCtx([{ name: 'f', fields: {} }]).canvas)
    expect(specs[0].label).toBe('Fusion')
    expect(specs[0].enabled).toBe(true)
  })

  it('extract reads an explicit disabled toggle', () => {
    const specs = extractFusionRuleSpecs(makeCtx([{ name: 'f', fields: { ...validItem, enabled: false } }]).canvas)
    expect(specs[0].enabled).toBe(false)
  })

  it('builds a Fusion rule body with the fixed template name and the declared toggle', () => {
    const specs = extractFusionRuleSpecs(makeCtx([{ name: 'f', fields: { ...validItem, enabled: false } }]).canvas)
    const body = buildFusionRuleBody(specs[0]) as { kind: string; properties: Record<string, unknown> }
    expect(body.kind).toBe(FUSION_KIND)
    expect(body.kind).toBe('Fusion')
    expect(body.properties.alertRuleTemplateName).toBe(FUSION_ALERT_RULE_TEMPLATE_NAME)
    expect(body.properties.enabled).toBe(false)
    // Only alertRuleTemplateName + enabled are writable — no other property leaks in.
    expect(Object.keys(body.properties).sort()).toEqual(['alertRuleTemplateName', 'enabled'])
  })

  it('picks the Fusion-kind item out of a mixed alertRules collection', () => {
    const items: LiveAlertRule[] = [
      { name: 'some-scheduled-rule', kind: 'Scheduled', properties: {} },
      { name: 'auto-generated-guid-1234', kind: 'Fusion', properties: { enabled: true } },
      { name: 'mssecurity--rule', kind: 'MicrosoftSecurityIncidentCreation', properties: {} },
    ]
    const found = pickFusionRule(items)
    expect(found?.name).toBe('auto-generated-guid-1234')
  })

  it('returns null when no Fusion-kind item exists', () => {
    const items: LiveAlertRule[] = [{ name: 'some-scheduled-rule', kind: 'Scheduled', properties: {} }]
    expect(pickFusionRule(items)).toBeNull()
  })

  it('uses a deterministic fallback ruleId only when no Fusion rule exists yet', () => {
    expect(FUSION_FALLBACK_RULE_ID).toBe('built-in-fusion')
  })

  it('uses the GA api-version for the alertRules collection (Fusion is not preview-only)', () => {
    expect(SENTINEL_API_VERSION).toBe('2024-09-01')
  })
})
