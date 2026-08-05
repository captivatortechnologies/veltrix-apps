import validate, {
  extractDecryptionRuleSpecs,
  buildDecryptionRuleFields,
  decryptionRuleDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-decryption-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-decryption-rules',
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

describe('Panorama Decryption Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal no-decrypt rule', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'no-decrypt-finance' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', type: 'ssl-outbound-proxy' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an unsupported action', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', action: 'inspect' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('requires at least one certificate for ssl-inbound-inspection', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', type: 'ssl-inbound-inspection', certificates: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.certificates'))).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'rule1' } },
        { name: 'b', fields: { name: 'RULE1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('defaults match fields and builds an empty-choice type element', () => {
    const spec = extractDecryptionRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'x' } }]).canvas)[0]
    const fields = buildDecryptionRuleFields(spec) as Record<string, unknown>
    expect(fields.from).toEqual({ member: ['any'] })
    expect(fields.category).toEqual({ member: ['any'] })
    expect(fields.type).toEqual({ 'ssl-forward-proxy': {} })
    expect(fields.action).toBe('no-decrypt')
  })

  it('builds ssl-inbound-inspection with certificates', () => {
    const spec = extractDecryptionRuleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', type: 'ssl-inbound-inspection', certificates: ['internal-web-cert'], action: 'decrypt' } }]).canvas,
    )[0]
    const fields = buildDecryptionRuleFields(spec) as Record<string, unknown>
    expect(fields.type).toEqual({ 'ssl-inbound-inspection': { certificates: { member: ['internal-web-cert'] } } })
  })

  it('detects action and type drift', () => {
    const spec = extractDecryptionRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'x' } }]).canvas)[0]
    const clean = decryptionRuleDriftDiffs(spec, {
      '@name': 'x',
      from: { member: ['any'] },
      to: { member: ['any'] },
      source: { member: ['any'] },
      destination: { member: ['any'] },
      category: { member: ['any'] },
      service: { member: ['any'] },
      type: { 'ssl-forward-proxy': {} },
      action: 'no-decrypt',
      disabled: 'no',
    })
    expect(clean).toHaveLength(0)
    const drifted = decryptionRuleDriftDiffs(spec, { '@name': 'x', type: { 'ssh-proxy': {} }, action: 'decrypt' })
    expect(drifted.some((d) => d.field.endsWith('.type'))).toBe(true)
    expect(drifted.some((d) => d.field.endsWith('.action'))).toBe(true)
  })
})
