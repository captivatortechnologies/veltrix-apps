import validate, { extractHashSpecs, hashKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_SHA1 = 'a'.repeat(40)

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-hash-allowlist',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-hash-allowlist',
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

describe('SentinelOne Hash Allowlist Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed allowlisted hash', async () => {
    const result = await validate(
      makeCtx([{ name: 'Hash', fields: { sha1: VALID_SHA1, os_type: 'windows' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects missing sha1 + os', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('sha1'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('os_type'))).toBe(true)
  })

  it('warns (but stays valid) on a non-40-char / non-hex sha1', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { sha1: 'not-a-hash', os_type: 'linux' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'hash_format')).toBe(true)
  })

  it('warns on a malformed sha256', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { sha1: VALID_SHA1, sha256: 'zzzz', os_type: 'macos' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'hash_format' && w.field.includes('sha256'))).toBe(true)
  })

  it('rejects an unsupported os', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { sha1: VALID_SHA1, os_type: 'solaris' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_os')).toBe(true)
  })

  it('rejects duplicate (sha1, os) case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { sha1: VALID_SHA1, os_type: 'windows' } },
        { name: 'b', fields: { sha1: VALID_SHA1.toUpperCase(), os_type: 'windows' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_hash')).toBe(true)
  })

  it('allows the same sha1 on a different os', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { sha1: VALID_SHA1, os_type: 'windows' } },
        { name: 'b', fields: { sha1: VALID_SHA1, os_type: 'linux' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('extractHashSpecs trims fields and hashKey normalizes case', () => {
    const specs = extractHashSpecs(
      makeCtx([{ name: 'e', fields: { sha1: `  ${VALID_SHA1.toUpperCase()}  `, os_type: 'windows', description: '  keep  ' } }]).canvas,
    )
    expect(specs[0].sha1).toBe(VALID_SHA1.toUpperCase())
    expect(specs[0].description).toBe('keep')
    expect(hashKey(specs[0])).toBe(hashKey({ sha1: VALID_SHA1, osType: 'windows' }))
  })
})
