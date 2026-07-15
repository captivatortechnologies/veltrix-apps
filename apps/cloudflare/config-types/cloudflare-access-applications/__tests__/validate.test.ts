import validate, { extractAccessAppSpecs, accessAppKey, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-access-applications',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-access-applications',
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

describe('Cloudflare Access Applications Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid self-hosted application', async () => {
    const result = await validate(
      makeCtx([{ name: 'App', fields: { name: 'Internal Wiki', domain: 'wiki.example.com', type: 'self_hosted' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing name/domain', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'self_hosted' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('domain'))).toBe(true)
  })

  it('rejects invalid app_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'App', domain: 'app.example.com', app_json: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects app_json that is a JSON array (not an object)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'App', domain: 'app.example.com', app_json: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('accepts a valid app_json object', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'App', domain: 'app.example.com', app_json: '{"app_launcher_visible":true}' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects duplicate application names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Wiki', domain: 'wiki.example.com' } },
        { name: 'b', fields: { name: 'wiki', domain: 'other.example.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_app')).toBe(true)
  })

  it('extractAccessAppSpecs applies defaults (type self_hosted, session_duration 24h) and trims', () => {
    const specs = extractAccessAppSpecs(
      makeCtx([{ name: 'r', fields: { name: '  Wiki  ', domain: '  wiki.example.com  ' } }]).canvas,
    )
    expect(specs[0].name).toBe('Wiki')
    expect(specs[0].domain).toBe('wiki.example.com')
    expect(specs[0].type).toBe('self_hosted')
    expect(specs[0].sessionDuration).toBe('24h')
  })

  it('accessAppKey folds name case and parseJsonObject treats blank as an empty object', () => {
    expect(accessAppKey('Wiki')).toBe(accessAppKey('  wiki  '))
    expect(parseJsonObject('').error).toBeNull()
    expect(parseJsonObject('').value).toEqual({})
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 })
    expect(parseJsonObject('nope').value).toBeNull()
  })
})
