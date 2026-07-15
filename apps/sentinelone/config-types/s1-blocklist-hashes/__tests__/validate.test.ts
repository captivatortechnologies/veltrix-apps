import validate, { extractHashSpecs, hashKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

// A real 40-char hex SHA1 (sha1 of the empty string) for the happy-path cases.
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-blocklist-hashes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-blocklist-hashes',
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

describe('SentinelOne Blocklist Hashes Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid blocklist hash', async () => {
    const result = await validate(
      makeCtx([{ name: 'Hash', fields: { sha1: SHA1, os_type: 'windows' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects missing sha1 + os', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('sha1'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('os_type'))).toBe(true)
  })

  it('rejects an unsupported os', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { sha1: SHA1, os_type: 'solaris' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_os')).toBe(true)
  })

  it('warns (but stays valid) on a non-40-char-hex sha1', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { sha1: 'abc123', os_type: 'windows' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'sha1_format')).toBe(true)
  })

  it('rejects duplicate (sha1,os) — case-insensitive', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { sha1: SHA1, os_type: 'windows' } },
        { name: 'b', fields: { sha1: SHA1.toUpperCase(), os_type: 'windows' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_hash')).toBe(true)
  })

  it('extractHashSpecs trims + lowercases and hashKey is stable', () => {
    const specs = extractHashSpecs(
      makeCtx([{ name: 'e', fields: { sha1: `  ${SHA1.toUpperCase()}  `, os_type: 'linux' } }]).canvas,
    )
    expect(specs[0].sha1).toBe(SHA1)
    expect(hashKey(specs[0])).toBe(hashKey({ sha1: SHA1, osType: 'linux' }))
  })
})
