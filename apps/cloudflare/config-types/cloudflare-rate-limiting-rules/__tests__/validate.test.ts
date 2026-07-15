import validate, { extractRateLimitRuleSpecs, slugRef, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-rate-limiting-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-rate-limiting-rules',
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

const RATELIMIT = '{"characteristics":["ip.src"],"period":60,"requests_per_period":100,"mitigation_timeout":600}'

describe('Cloudflare Rate Limiting Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rate Limit Rule',
          fields: { name: 'Throttle API', action: 'block', expression: '(http.request.uri.path contains "/api/")', ratelimit_json: RATELIMIT },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name and expression', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'block', ratelimit_json: RATELIMIT } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('expression'))).toBe(true)
  })

  it('rejects an unsupported action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'r', action: 'nope', expression: 'true', ratelimit_json: RATELIMIT } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects duplicate refs (names that slug the same)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Throttle API', action: 'block', expression: 'true', ratelimit_json: RATELIMIT } },
        { name: 'b', fields: { name: 'throttle api', action: 'log', expression: 'true', ratelimit_json: RATELIMIT } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('rejects a missing ratelimit_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'r', action: 'block', expression: 'true' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('ratelimit_json'))).toBe(true)
  })

  it('rejects invalid ratelimit_json (array, not object)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'r', action: 'block', expression: 'true', ratelimit_json: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('slugRef + parseJsonObject behave', () => {
    expect(slugRef('Throttle API!')).toBe('throttle_api')
    expect(parseJsonObject('   ').error).toBeNull()
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 })
    expect(parseJsonObject('nope').error).toBeTruthy()
    const specs = extractRateLimitRuleSpecs(makeCtx([{ name: 'r', fields: { name: '  My Rule  ' } }]).canvas)
    expect(specs[0].ref).toBe('my_rule')
    expect(specs[0].enabled).toBe(true)
  })
})
