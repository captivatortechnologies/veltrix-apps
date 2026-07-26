import validate, { extractRuleSettingSpecs, ruleKey } from '../validate'
import { diffRule } from '../deploy'
import type { LiveDetectionRule } from '../../../lib/insightidr-rules'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightidr-detection-rule-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightidr-detection-rule-settings',
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

describe('InsightIDR Detection Rule Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule setting', async () => {
    const result = await validate(
      makeCtx([{ name: 'R', fields: { rule_name: 'Suspicious Auth', rule_action: 'CREATES_INVESTIGATIONS', priority_level: 'HIGH' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing rule_name / rule_action', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { priority_level: 'LOW' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_action'))).toBe(true)
  })

  it('rejects an unsupported action and priority', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { rule_name: 'R', rule_action: 'NOPE', priority_level: 'URGENT' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_action')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('rejects duplicate rule names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { rule_name: 'Rule A', rule_action: 'OFF' } },
        { name: 'b', fields: { rule_name: 'rule a', rule_action: 'CREATES_ALERTS' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extract + ruleKey behave', () => {
    const specs = extractRuleSettingSpecs(makeCtx([{ name: 'r', fields: { rule_name: '  Rule X  ', rule_action: 'OFF' } }]).canvas)
    expect(specs[0].ruleName).toBe('Rule X')
    expect(ruleKey(specs[0])).toBe('rule x')
  })

  it('diffRule emits only changed fields with inverse restore events', () => {
    const rule: LiveDetectionRule = { rrn: 'rrn:1', rule: { name: 'R', rule_action: 'OFF', priority_level: 'LOW' } }
    const { events, restore } = diffRule(
      { sectionName: 's', ruleName: 'R', ruleAction: 'CREATES_INVESTIGATIONS', priorityLevel: 'LOW' },
      rule,
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'SET', field: 'rule_action', new_value: 'CREATES_INVESTIGATIONS', old_value: 'OFF' })
    expect(restore[0]).toEqual({ type: 'SET', field: 'rule_action', new_value: 'OFF', old_value: 'CREATES_INVESTIGATIONS' })
  })

  it('diffRule is a no-op when already matching', () => {
    const rule: LiveDetectionRule = { rrn: 'rrn:1', rule: { name: 'R', rule_action: 'CREATES_ALERTS', priority_level: 'HIGH' } }
    const { events } = diffRule({ sectionName: 's', ruleName: 'R', ruleAction: 'CREATES_ALERTS', priorityLevel: 'HIGH' }, rule)
    expect(events).toHaveLength(0)
  })
})
