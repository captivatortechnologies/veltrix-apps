import validate, {
  extractTransformRuleSpecs,
  phaseFor,
  slugRef,
  parseJsonObject,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-transform-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-transform-rules',
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

const URL_REWRITE = { transform_type: 'url_rewrite', transform_json: '{"uri":{"path":{"value":"/new"}}}' }

describe('Cloudflare Transform Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid url_rewrite rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'Transform Rule', fields: { name: 'Rewrite old path', expression: '(http.request.uri.path eq "/old")', ...URL_REWRITE } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid multi-phase canvas (all three transform types)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Rewrite path', expression: 'true', ...URL_REWRITE } },
        { name: 'b', fields: { name: 'Set req header', expression: 'true', transform_type: 'request_headers', transform_json: '{"headers":{"X-Foo":{"operation":"set","value":"bar"}}}' } },
        { name: 'c', fields: { name: 'Set resp header', expression: 'true', transform_type: 'response_headers', transform_json: '{"headers":{"X-Bar":{"operation":"set","value":"baz"}}}' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name, expression and transform_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { transform_type: 'url_rewrite' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('expression'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('transform_json'))).toBe(true)
  })

  it('rejects an unsupported transform_type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'r', expression: 'true', transform_type: 'nope', transform_json: '{"uri":{}}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_transform_type')).toBe(true)
  })

  it('rejects duplicate refs (names that slug the same)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Rewrite Path', expression: 'true', ...URL_REWRITE } },
        { name: 'b', fields: { name: 'rewrite path', expression: 'true', ...URL_REWRITE } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('rejects invalid transform_json (array, not object)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'r', expression: 'true', transform_type: 'url_rewrite', transform_json: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('extracts specs across all three phases (multi-phase)', () => {
    const specs = extractTransformRuleSpecs(
      makeCtx([
        { name: 'a', fields: { name: 'Rewrite path', expression: 'true', ...URL_REWRITE } },
        { name: 'b', fields: { name: 'Set req header', expression: 'true', transform_type: 'request_headers', transform_json: '{"headers":{}}' } },
        { name: 'c', fields: { name: 'Set resp header', expression: 'true', transform_type: 'response_headers', transform_json: '{"headers":{}}' } },
      ]).canvas,
    )
    expect(specs.map((s) => s.phase)).toEqual([
      'http_request_transform',
      'http_request_late_transform',
      'http_response_headers_transform',
    ])
    expect(new Set(specs.map((s) => s.phase)).size).toBe(3)
  })

  it('phaseFor maps transform types to phases and slugRef/parseJsonObject behave', () => {
    expect(phaseFor('url_rewrite')).toBe('http_request_transform')
    expect(phaseFor('request_headers')).toBe('http_request_late_transform')
    expect(phaseFor('response_headers')).toBe('http_response_headers_transform')
    expect(phaseFor('nope')).toBeNull()
    expect(slugRef('Rewrite Old Path!')).toBe('rewrite_old_path')
    expect(parseJsonObject('   ').error).toBeNull()
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 })
    expect(parseJsonObject('nope').error).toBeTruthy()
    const specs = extractTransformRuleSpecs(makeCtx([{ name: 'r', fields: { name: '  My Rule  ' } }]).canvas)
    expect(specs[0].ref).toBe('my_rule')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].transformType).toBe('url_rewrite')
  })
})
