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
    entityType: 'tls-inspection-rules',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cato-networks',
    customerId: 'cust-1',
    configTypeId: 'tls-inspection-rules',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('TLS Inspection Rules validate', () => {
  it('accepts an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(true)
  })

  it('validates a minimal rule', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Inspect Cloud Apps', section: 'Default' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing section', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Rule' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_SECTION')).toBe(true)
  })

  it('rejects invalid rule_json', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Rule', section: 'Default', rule_json: '{bad' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })
})

describe('extractRuleSpecs / buildRuleData', () => {
  it('defaults action to INSPECT and untrustedCertificateAction to ALLOW', () => {
    const specs = extractRuleSpecs(makeCanvas([{ name: 'i1', fields: { name: 'Rule', section: 'Default' } }]))
    expect(specs[0].action).toBe('INSPECT')
    expect(specs[0].untrustedCertificateAction).toBe('ALLOW')
  })

  it('merges rule_json under first-class fields', () => {
    const specs = extractRuleSpecs(
      makeCanvas([
        {
          name: 'i1',
          fields: { name: 'Rule', section: 'Default', action: 'BYPASS', rule_json: '{"action":"INSPECT","source":{"site":[]}}' },
        },
      ]),
    )
    const body = buildRuleData(specs[0])
    expect(body.action).toBe('BYPASS')
    expect(body.source).toEqual({ site: [] })
  })
})
