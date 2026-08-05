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
    entityType: 'internet-firewall-rules',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cato-networks',
    customerId: 'cust-1',
    configTypeId: 'internet-firewall-rules',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Internet Firewall Rules validate', () => {
  it('accepts an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(true)
  })

  it('validates a minimal rule', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Block Gambling', section: 'Default' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { section: 'Default' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a missing section', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Block Gambling' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_SECTION')).toBe(true)
  })

  it('rejects a duplicate rule name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'i1', fields: { name: 'Block Gambling', section: 'Default' } },
        { name: 'i2', fields: { name: 'block gambling', section: 'Default' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('requires positionRuleName when position is AFTER_RULE', async () => {
    const result = await validate(
      makeCtx([{ name: 'i1', fields: { name: 'Block Gambling', section: 'Default', position: 'AFTER_RULE' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MISSING_POSITION_REF')).toBe(true)
  })

  it('rejects invalid rule_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'i1', fields: { name: 'Block Gambling', section: 'Default', rule_json: '{not valid json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('rejects rule_json that is a JSON array, not an object', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Rule', section: 'Default', rule_json: '[1,2,3]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('accepts valid rule_json', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'i1',
          fields: {
            name: 'Block Gambling',
            section: 'Default',
            rule_json: '{"destination":{"appCategory":[{"by":"NAME","input":"Gambling"}]}}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractRuleSpecs', () => {
  it('defaults action/connectionOrigin/position/enabled', () => {
    const specs = extractRuleSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Rule', section: 'Default' } }]))
    expect(specs[0].action).toBe('BLOCK')
    expect(specs[0].connectionOrigin).toBe('ANY')
    expect(specs[0].position).toBe('FIRST_IN_SECTION')
    expect(specs[0].enabled).toBe(true)
  })

  it('respects enabled: false', () => {
    const specs = extractRuleSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Rule', section: 'Default', enabled: false } }]))
    expect(specs[0].enabled).toBe(false)
  })

  it('falls back to a valid action when given an unrecognized value', () => {
    const specs = extractRuleSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Rule', section: 'Default', action: 'NUKE' } }]))
    expect(specs[0].action).toBe('BLOCK')
  })
})

describe('buildRuleData', () => {
  it('always includes name/description/enabled/action/connectionOrigin', () => {
    const body = buildRuleData({
      name: 'Block Gambling',
      description: '',
      enabled: true,
      section: 'Default',
      action: 'BLOCK',
      connectionOrigin: 'ANY',
      position: 'FIRST_IN_SECTION',
    })
    expect(body).toEqual({ name: 'Block Gambling', description: '', enabled: true, action: 'BLOCK', connectionOrigin: 'ANY' })
  })

  it('merges rule_json and lets first-class fields win over same-named JSON keys', () => {
    const body = buildRuleData({
      name: 'Block Gambling',
      description: 'desc',
      enabled: true,
      section: 'Default',
      action: 'BLOCK',
      connectionOrigin: 'ANY',
      position: 'FIRST_IN_SECTION',
      ruleJson: '{"action":"ALLOW","destination":{"appCategory":[{"by":"NAME","input":"Gambling"}]}}',
    })
    expect(body.action).toBe('BLOCK')
    expect(body.destination).toEqual({ appCategory: [{ by: 'NAME', input: 'Gambling' }] })
  })

  it('ignores invalid rule_json (treated as no extra criteria)', () => {
    const body = buildRuleData({
      name: 'Rule',
      description: '',
      enabled: true,
      section: 'Default',
      action: 'BLOCK',
      connectionOrigin: 'ANY',
      position: 'FIRST_IN_SECTION',
      ruleJson: 'not json',
    })
    expect(body).toEqual({ name: 'Rule', description: '', enabled: true, action: 'BLOCK', connectionOrigin: 'ANY' })
  })
})
