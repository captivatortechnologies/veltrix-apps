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
    entityType: 'wan-firewall-rules',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cato-networks',
    customerId: 'cust-1',
    configTypeId: 'wan-firewall-rules',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('WAN Firewall Rules validate', () => {
  it('accepts an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(true)
  })

  it('validates a minimal rule', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Allow DC SSH', section: 'Default' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing section', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Allow DC SSH' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_SECTION')).toBe(true)
  })

  it('rejects invalid rule_json', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Rule', section: 'Default', rule_json: '{bad' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })
})

describe('extractRuleSpecs', () => {
  it('defaults direction to TO', () => {
    const specs = extractRuleSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Rule', section: 'Default' } }]))
    expect(specs[0].direction).toBe('TO')
  })

  it('respects direction: BOTH', () => {
    const specs = extractRuleSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Rule', section: 'Default', direction: 'BOTH' } }]))
    expect(specs[0].direction).toBe('BOTH')
  })
})

describe('buildRuleData', () => {
  it('includes direction', () => {
    const body = buildRuleData({
      name: 'Rule',
      description: '',
      enabled: true,
      section: 'Default',
      action: 'ALLOW',
      direction: 'BOTH',
      connectionOrigin: 'ANY',
      position: 'FIRST_IN_SECTION',
    })
    expect(body.direction).toBe('BOTH')
    expect(body.action).toBe('ALLOW')
  })
})
