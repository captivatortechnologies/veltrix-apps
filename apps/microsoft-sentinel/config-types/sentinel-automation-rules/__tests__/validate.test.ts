import validate, { extractAutomationSpecs, ruleKey } from '../validate'
import { buildAutomationRuleBody } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-automation-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-automation-rules',
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
  rule_name: 'Auto-triage phishing',
  enabled: true,
  order: 1,
  triggers_on: 'Incidents',
  triggers_when: 'Created',
  set_severity: 'High',
  set_status: 'Active',
}

describe('Sentinel Automation Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete automation rule', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a rule name', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, rule_name: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an out-of-range order', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, order: 5000 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_order')).toBe(true)
  })

  it('rejects an invalid trigger', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, triggers_on: 'Everything' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_trigger')).toBe(true)
  })

  it('requires at least one action (severity or status)', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { ...validRule, set_severity: '', set_status: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_action')).toBe(true)
  })

  it('extract derives a deterministic ruleId slug', () => {
    const specs = extractAutomationSpecs(makeCtx([{ name: 'r', fields: { ...validRule, rule_name: '  Auto Triage  ' } }]).canvas)
    expect(specs[0].ruleName).toBe('Auto Triage')
    expect(specs[0].ruleId).toBe('auto-triage')
    expect(ruleKey('Auto Triage')).toBe('auto-triage')
  })

  it('builds an automation rule body with a ModifyProperties action', () => {
    const specs = extractAutomationSpecs(makeCtx([{ name: 'r', fields: { ...validRule } }]).canvas)
    const body = buildAutomationRuleBody(specs[0]) as {
      properties: { displayName: string; order: number; triggeringLogic: Record<string, unknown>; actions: Array<{ actionType: string; actionConfiguration: Record<string, string> }> }
    }
    expect(body.properties.displayName).toBe('Auto-triage phishing')
    expect(body.properties.triggeringLogic.triggersOn).toBe('Incidents')
    expect(body.properties.actions[0].actionType).toBe('ModifyProperties')
    expect(body.properties.actions[0].actionConfiguration.severity).toBe('High')
    expect(body.properties.actions[0].actionConfiguration.status).toBe('Active')
  })
})
