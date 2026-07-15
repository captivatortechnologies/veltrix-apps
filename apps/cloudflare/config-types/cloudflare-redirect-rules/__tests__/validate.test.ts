import validate, { extractRedirectRuleSpecs, slugRef, parseJsonObject } from '../validate'
import { buildRule } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-redirect-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-redirect-rules',
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

const REDIRECT_JSON = '{"target_url":{"value":"https://example.com/new"},"status_code":301,"preserve_query_string":true}'

describe('Cloudflare Redirect Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Redirect Rule', fields: { name: 'Old to new', expression: '(http.request.uri.path eq "/old")', redirect_json: REDIRECT_JSON } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name and expression', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { redirect_json: REDIRECT_JSON } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('expression'))).toBe(true)
  })

  it('rejects a missing redirect_json (required)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'r', expression: 'true' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('redirect_json'))).toBe(true)
  })

  it('rejects invalid redirect_json (array, not object)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'r', expression: 'true', redirect_json: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate refs (names that slug the same)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Old To New', expression: 'true', redirect_json: REDIRECT_JSON } },
        { name: 'b', fields: { name: 'old to new', expression: 'true', redirect_json: REDIRECT_JSON } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('slugRef + parseJsonObject + extract behave', () => {
    expect(slugRef('Old To New!')).toBe('old_to_new')
    expect(parseJsonObject('   ').error).toBeNull()
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 })
    expect(parseJsonObject('nope').error).toBeTruthy()
    const specs = extractRedirectRuleSpecs(makeCtx([{ name: 'r', fields: { name: '  My Redirect  ' } }]).canvas)
    expect(specs[0].ref).toBe('my_redirect')
    expect(specs[0].enabled).toBe(true)
  })

  it('buildRule wraps redirect_json under action_parameters.from_value with a fixed redirect action', () => {
    const spec = extractRedirectRuleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'Old to new', expression: 'true', redirect_json: REDIRECT_JSON } }]).canvas,
    )[0]
    const rule = buildRule(spec) as {
      ref: string
      action: string
      action_parameters: { from_value: Record<string, unknown> }
    }
    expect(rule.ref).toBe('old_to_new')
    expect(rule.action).toBe('redirect')
    expect(rule.action_parameters.from_value).toEqual({
      target_url: { value: 'https://example.com/new' },
      status_code: 301,
      preserve_query_string: true,
    })
  })
})
