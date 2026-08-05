import validate from '../validate'
import { blockedItemKey, blockedItemMatches, buildBlockedItemBody, extractBlockedItemSpecs } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sophos-central',
    customerId: 'cust-1',
    configTypeId: 'blocked-items',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sophos-central',
      entityType: 'blocked-items',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validSha256 = 'a'.repeat(64)
const validFields = {
  sha256: validSha256,
  fileName: 'evil.exe',
  path: '$desktop/evil.exe',
  comment: 'Confirmed malware, INC-1234',
}

describe('Sophos Central Blocked Items Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed blocked item', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires sha256 and comment', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { fileName: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(2)
  })

  it('rejects a malformed sha256', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, sha256: 'not-a-hash' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SHA256')).toBe(true)
  })

  it('rejects a sha256 with the wrong length', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, sha256: 'abc123' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SHA256')).toBe(true)
  })

  it('warns on a duplicate sha256 (last one wins)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_SHA256')).toBe(true)
  })

  it('is case-insensitive when detecting duplicates', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: validFields },
        { name: 'b', fields: { ...validFields, sha256: validSha256.toUpperCase() } },
      ]),
    )
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_SHA256')).toBe(true)
  })
})

describe('Sophos Central Blocked Items shared helpers', () => {
  it('blockedItemKey trims and lower-cases', () => {
    expect(blockedItemKey(`  ${validSha256.toUpperCase()}  `)).toBe(validSha256)
  })

  it('extractBlockedItemSpecs reads and trims every field', () => {
    const specs = extractBlockedItemSpecs(
      makeCtx([{ name: 'e', fields: { sha256: `  ${validSha256}  `, fileName: ' evil.exe ', path: '', comment: ' bad ' } }]).canvas,
    )
    expect(specs[0].sha256).toBe(validSha256)
    expect(specs[0].fileName).toBe('evil.exe')
    expect(specs[0].comment).toBe('bad')
  })

  it('buildBlockedItemBody omits blank optional properties', () => {
    const body = buildBlockedItemBody({ itemName: 'x', sha256: validSha256, fileName: '', path: '', comment: 'bad' })
    expect(body).toEqual({ properties: { sha256: validSha256 }, comment: 'bad' })
  })

  it('buildBlockedItemBody includes fileName/path when present', () => {
    const body = buildBlockedItemBody({ itemName: 'x', sha256: validSha256, fileName: 'evil.exe', path: '/tmp/evil', comment: 'bad' })
    expect(body.properties).toEqual({ sha256: validSha256, fileName: 'evil.exe', path: '/tmp/evil' })
  })

  it('blockedItemMatches compares fileName/path/comment', () => {
    const spec = { itemName: 'x', sha256: validSha256, fileName: 'evil.exe', path: '', comment: 'bad' }
    expect(blockedItemMatches(spec, { type: 'sha256', properties: { sha256: validSha256, fileName: 'evil.exe' }, comment: 'bad' })).toBe(true)
    expect(blockedItemMatches(spec, { type: 'sha256', properties: { sha256: validSha256, fileName: 'other.exe' }, comment: 'bad' })).toBe(false)
  })
})
