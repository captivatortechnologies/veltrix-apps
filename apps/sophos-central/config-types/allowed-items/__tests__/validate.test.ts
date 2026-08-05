import validate from '../validate'
import {
  allowedItemKey,
  allowedItemProperties,
  allowedItemPropertiesMatch,
  buildAllowedItemBody,
  extractAllowedItemSpecs,
  liveAllowedItemValue,
} from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sophos-central',
    customerId: 'cust-1',
    configTypeId: 'allowed-items',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sophos-central',
      entityType: 'allowed-items',
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

const validSha256 = 'b'.repeat(64)
const validFields = {
  type: 'sha256',
  value: validSha256,
  fileName: 'app.exe',
  comment: 'Known internal tool',
}

describe('Sophos Central Allowed Items Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed allowed item', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires type, value and comment', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(3)
  })

  it('rejects an unknown type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, type: 'bogus' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('rejects a malformed sha256 value when type is sha256', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, value: 'not-a-hash' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SHA256')).toBe(true)
  })

  it('accepts a non-hex value for a path type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, type: 'path', value: '$desktop/app.exe' } }]))
    expect(result.valid).toBe(true)
  })

  it('warns on a duplicate (type, value) pair', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_ITEM')).toBe(true)
  })

  it('does NOT flag the same value across different types', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, type: 'path', value: 'same-value' } },
        { name: 'b', fields: { ...validFields, type: 'certificateSigner', value: 'same-value' } },
      ]),
    )
    expect(result.warnings.filter((w) => w.code === 'DUPLICATE_ITEM')).toHaveLength(0)
  })
})

describe('Sophos Central Allowed Items shared helpers', () => {
  it('allowedItemKey combines type and lower-cased value', () => {
    expect(allowedItemKey('sha256', `  ${validSha256.toUpperCase()}  `)).toBe(`sha256::${validSha256}`)
  })

  it('allowedItemProperties maps sha256 type onto properties.sha256', () => {
    expect(allowedItemProperties({ type: 'sha256', value: validSha256, fileName: '' })).toEqual({ sha256: validSha256 })
  })

  it('allowedItemProperties maps path and posixPath types onto properties.path', () => {
    expect(allowedItemProperties({ type: 'path', value: '/tmp/x', fileName: '' })).toEqual({ path: '/tmp/x' })
    expect(allowedItemProperties({ type: 'posixPath', value: '/tmp/x', fileName: '' })).toEqual({ path: '/tmp/x' })
  })

  it('allowedItemProperties maps certificateSigner type onto properties.certificateSigner', () => {
    expect(allowedItemProperties({ type: 'certificateSigner', value: 'Acme Inc', fileName: '' })).toEqual({ certificateSigner: 'Acme Inc' })
  })

  it('allowedItemProperties includes fileName when present', () => {
    expect(allowedItemProperties({ type: 'sha256', value: validSha256, fileName: 'app.exe' })).toEqual({
      sha256: validSha256,
      fileName: 'app.exe',
    })
  })

  it('buildAllowedItemBody spreads type/properties/comment', () => {
    const body = buildAllowedItemBody({ itemName: 'x', type: 'sha256', value: validSha256, fileName: '', comment: 'ok' })
    expect(body).toEqual({ type: 'sha256', properties: { sha256: validSha256 }, comment: 'ok' })
  })

  it('liveAllowedItemValue reads the type-specific property', () => {
    expect(liveAllowedItemValue({ type: 'sha256', properties: { sha256: validSha256 }, comment: '' })).toBe(validSha256)
    expect(liveAllowedItemValue({ type: 'path', properties: { path: '/tmp/x' }, comment: '' })).toBe('/tmp/x')
    expect(liveAllowedItemValue({ type: 'certificateSigner', properties: { certificateSigner: 'Acme' }, comment: '' })).toBe('Acme')
  })

  it('extractAllowedItemSpecs reads and trims every field', () => {
    const specs = extractAllowedItemSpecs(
      makeCtx([{ name: 'e', fields: { type: ' sha256 ', value: `  ${validSha256}  `, fileName: '', comment: ' ok ' } }]).canvas,
    )
    expect(specs[0].type).toBe('sha256')
    expect(specs[0].value).toBe(validSha256)
    expect(specs[0].comment).toBe('ok')
  })

  it('allowedItemPropertiesMatch compares mapped properties', () => {
    const spec = { itemName: 'x', type: 'sha256', value: validSha256, fileName: 'app.exe', comment: 'ok' }
    expect(allowedItemPropertiesMatch(spec, { type: 'sha256', properties: { sha256: validSha256, fileName: 'app.exe' }, comment: 'ok' })).toBe(true)
    expect(allowedItemPropertiesMatch(spec, { type: 'sha256', properties: { sha256: validSha256, fileName: 'other.exe' }, comment: 'ok' })).toBe(
      false,
    )
  })
})
