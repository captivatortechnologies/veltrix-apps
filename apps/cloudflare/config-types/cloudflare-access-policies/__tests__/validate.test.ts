import validate, { extractAccessPolicySpecs, parseJsonArray } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-access-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-access-policies',
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

const INCLUDE = '[{"email":{"email":"user@example.com"}}]'

describe('Cloudflare Access Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'Engineers', decision: 'allow', include_json: INCLUDE } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { decision: 'allow', include_json: INCLUDE } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported decision', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'p1', decision: 'maybe', include_json: INCLUDE } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_decision')).toBe(true)
  })

  it('rejects duplicate policy names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Engineers', decision: 'allow', include_json: INCLUDE } },
        { name: 'b', fields: { name: 'Engineers', decision: 'deny', include_json: INCLUDE } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('requires include_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'p1', decision: 'allow' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('include_json'))).toBe(true)
  })

  it('rejects include_json that is not a non-empty array', async () => {
    const notArray = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'p1', decision: 'allow', include_json: '{"email":{}}' } }]),
    )
    expect(notArray.valid).toBe(false)
    expect(notArray.errors.some((e) => e.code === 'invalid_json' && e.field.includes('include_json'))).toBe(true)

    const empty = await validate(
      makeCtx([{ name: 'p2sec', fields: { name: 'p2', decision: 'allow', include_json: '[]' } }]),
    )
    expect(empty.valid).toBe(false)
    expect(empty.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects require_json / exclude_json that are not valid JSON arrays', async () => {
    const badRequire = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'p1', decision: 'allow', include_json: INCLUDE, require_json: '{}' } }]),
    )
    expect(badRequire.valid).toBe(false)
    expect(badRequire.errors.some((e) => e.code === 'invalid_json' && e.field.includes('require_json'))).toBe(true)

    const badExclude = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'p1', decision: 'allow', include_json: INCLUDE, exclude_json: 'not json' } }]),
    )
    expect(badExclude.valid).toBe(false)
    expect(badExclude.errors.some((e) => e.code === 'invalid_json' && e.field.includes('exclude_json'))).toBe(true)
  })

  it('parseJsonArray: blank is an empty array, objects error, arrays pass', () => {
    expect(parseJsonArray('').value).toEqual([])
    expect(parseJsonArray('   ').error).toBeNull()
    expect(parseJsonArray('{"a":1}').value).toBeNull()
    expect(parseJsonArray('{"a":1}').error).toBe('must be a JSON array')
    expect(parseJsonArray('[{"everyone":{}}]').value).toEqual([{ everyone: {} }])
    expect(parseJsonArray('nope').value).toBeNull()
  })

  it('extractAccessPolicySpecs trims name and defaults decision to allow', () => {
    const specs = extractAccessPolicySpecs(makeCtx([{ name: 'r', fields: { name: '  Team  ', include_json: INCLUDE } }]).canvas)
    expect(specs[0].name).toBe('Team')
    expect(specs[0].decision).toBe('allow')
  })
})
