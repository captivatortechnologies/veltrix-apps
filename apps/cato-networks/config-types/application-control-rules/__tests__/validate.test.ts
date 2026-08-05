import validate, { buildRuleData, extractRuleSpecs } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCanvas(items: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'cato-networks',
    entityType: 'application-control-rules',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cato-networks',
    customerId: 'cust-1',
    configTypeId: 'application-control-rules',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const APP_RULE_JSON = JSON.stringify({ applicationRule: { application: { appCategory: { by: 'NAME', input: 'Social Media' } }, action: 'BLOCK' } })

describe('Application Control Rules validate', () => {
  it('accepts an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(true)
  })

  it('validates a minimal application rule', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Block Social Media', section: 'Default', rule_json: APP_RULE_JSON } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing rule_json', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Rule', section: 'Default' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_RULE_BODY')).toBe(true)
  })

  it('rejects invalid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Rule', section: 'Default', rule_json: 'nope' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('rejects a rule_json wrapper key mismatched with ruleType', async () => {
    const result = await validate(
      makeCtx([{ name: 'i1', fields: { name: 'Rule', section: 'Default', ruleType: 'DATA', rule_json: APP_RULE_JSON } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'RULE_TYPE_KEY_MISMATCH')).toBe(true)
  })

  it('accepts a dataRule wrapper when ruleType is DATA', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'i1',
          fields: { name: 'Rule', section: 'Default', ruleType: 'DATA', rule_json: JSON.stringify({ dataRule: { action: 'BLOCK' } }) },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractRuleSpecs / buildRuleData', () => {
  it('defaults ruleType to APPLICATION', () => {
    const specs = extractRuleSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Rule', section: 'Default' } }]))
    expect(specs[0].ruleType).toBe('APPLICATION')
  })

  it('merges rule_json under first-class fields', () => {
    const specs = extractRuleSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Rule', section: 'Default', rule_json: APP_RULE_JSON } }]))
    const body = buildRuleData(specs[0])
    expect(body.name).toBe('Rule')
    expect(body.ruleType).toBe('APPLICATION')
    expect((body as any).applicationRule.action).toBe('BLOCK')
  })
})
