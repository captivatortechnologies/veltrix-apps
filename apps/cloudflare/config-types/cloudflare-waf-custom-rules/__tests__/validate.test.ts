import validate, { extractCustomRuleSpecs, slugRef, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-waf-custom-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-waf-custom-rules',
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

describe('Cloudflare WAF Custom Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'Custom Rule', fields: { name: 'Block bad IP', action: 'block', expression: '(ip.src eq 203.0.113.10)' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name and expression', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'block' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('expression'))).toBe(true)
  })

  it('rejects an unsupported action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'r', action: 'nope', expression: 'true' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects duplicate refs (names that slug the same)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Block Bad IP', action: 'block', expression: 'true' } },
        { name: 'b', fields: { name: 'block bad ip', action: 'log', expression: 'true' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('rejects invalid action_parameters_json (array, not object)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'r', action: 'block', expression: 'true', action_parameters_json: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('slugRef + parseJsonObject behave', () => {
    expect(slugRef('Block Bad IP!')).toBe('block_bad_ip')
    expect(parseJsonObject('   ').error).toBeNull()
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 })
    expect(parseJsonObject('nope').error).toBeTruthy()
    const specs = extractCustomRuleSpecs(makeCtx([{ name: 'r', fields: { name: '  My Rule  ' } }]).canvas)
    expect(specs[0].ref).toBe('my_rule')
    expect(specs[0].enabled).toBe(true)
  })
})
