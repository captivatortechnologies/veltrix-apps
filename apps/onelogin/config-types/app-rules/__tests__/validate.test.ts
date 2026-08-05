import validate, { appRuleKey, extractAppRuleSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'onelogin',
    customerId: 'cust-1',
    configTypeId: 'app-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onelogin',
      entityType: 'app-rules',
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

const validConditions = '[{"source":"department","operator":"=","value":"Engineering"}]'
const validActions = '[{"action":"set_role","value":["12345"]}]'

describe('OneLogin App Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'Rule', fields: { appId: 123, name: 'Grant Admin', conditionsJson: validConditions, actionsJson: validActions } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing appId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Grant Admin', conditionsJson: validConditions, actionsJson: validActions } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('appId'))).toBe(true)
  })

  it('rejects a non-integer appId', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { appId: 1.5, name: 'Grant Admin', conditionsJson: validConditions, actionsJson: validActions } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_app_id')).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { appId: 123, conditionsJson: validConditions, actionsJson: validActions } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate (appId, name) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { appId: 123, name: 'Grant Admin', conditionsJson: validConditions, actionsJson: validActions } },
        { name: 'sec2', fields: { appId: 123, name: 'Grant Admin', conditionsJson: validConditions, actionsJson: validActions } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('allows the same rule name across two different apps', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { appId: 123, name: 'Grant Admin', conditionsJson: validConditions, actionsJson: validActions } },
        { name: 'sec2', fields: { appId: 456, name: 'Grant Admin', conditionsJson: validConditions, actionsJson: validActions } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects malformed conditions/actions', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { appId: 123, name: 'Grant Admin', conditionsJson: '[]', actionsJson: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_conditions')).toBe(true)
    expect(result.errors.some((e) => e.code === 'invalid_actions')).toBe(true)
  })
})

describe('extractAppRuleSpecs', () => {
  it('parses appId as a number', () => {
    const specs = extractAppRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'app-rules',
      items: [],
      sections: [{ name: 'sec1', fields: { appId: '123', name: 'Grant Admin' } }],
      snapshot: {},
    })
    expect(specs[0].appId).toBe(123)
  })
})

describe('appRuleKey', () => {
  it('produces the same key for matching appId + name', () => {
    expect(appRuleKey(123, 'Grant Admin')).toBe(appRuleKey(123, 'Grant Admin'))
  })
  it('produces a different key for the same name under a different app', () => {
    expect(appRuleKey(123, 'Grant Admin') === appRuleKey(456, 'Grant Admin')).toBe(false)
  })
})
