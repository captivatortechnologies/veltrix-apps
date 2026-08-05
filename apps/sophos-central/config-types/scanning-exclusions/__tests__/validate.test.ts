import validate from '../validate'
import { buildScanningExclusionBody, extractScanningExclusionSpecs, scanningExclusionKey, scanningExclusionMatches } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sophos-central',
    customerId: 'cust-1',
    configTypeId: 'scanning-exclusions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sophos-central',
      entityType: 'scanning-exclusions',
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

const validFields = { type: 'path', value: '$programfiles\\Acme\\acme.exe', scanMode: 'onDemandAndOnAccess', comment: 'Trusted app' }

describe('Sophos Central Scanning Exclusions Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed exclusion', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires type and value (comment is optional)', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(2)
  })

  it('rejects an unknown type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, type: 'bogus' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('rejects an unknown scanMode', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, scanMode: 'bogus' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SCAN_MODE')).toBe(true)
  })

  it('warns when scanMode is set on a type that does not support one', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, type: 'behavioral', scanMode: 'onAccess' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'SCAN_MODE_NOT_SUPPORTED')).toBe(true)
  })

  it('accepts a blank scanMode', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, scanMode: '' } }]))
    expect(result.valid).toBe(true)
  })

  it('warns on a duplicate (type, value) pair', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_EXCLUSION')).toBe(true)
  })
})

describe('Sophos Central Scanning Exclusions shared helpers', () => {
  it('scanningExclusionKey combines type and lower-cased value', () => {
    expect(scanningExclusionKey('path', '  C:\\Foo  ')).toBe('path::c:\\foo')
  })

  it('buildScanningExclusionBody omits a blank scanMode/comment', () => {
    expect(buildScanningExclusionBody({ itemName: 'x', type: 'path', value: '/tmp', scanMode: '', comment: '' })).toEqual({
      type: 'path',
      value: '/tmp',
    })
  })

  it('buildScanningExclusionBody includes scanMode/comment when present', () => {
    expect(buildScanningExclusionBody({ itemName: 'x', type: 'path', value: '/tmp', scanMode: 'onAccess', comment: 'why' })).toEqual({
      type: 'path',
      value: '/tmp',
      scanMode: 'onAccess',
      comment: 'why',
    })
  })

  it('extractScanningExclusionSpecs reads and trims every field', () => {
    const specs = extractScanningExclusionSpecs(
      makeCtx([{ name: 'e', fields: { type: ' path ', value: ' /tmp ', scanMode: '', comment: ' why ' } }]).canvas,
    )
    expect(specs[0].type).toBe('path')
    expect(specs[0].value).toBe('/tmp')
    expect(specs[0].comment).toBe('why')
  })

  it('scanningExclusionMatches ignores scanMode when the spec leaves it blank', () => {
    const spec = { itemName: 'x', type: 'path', value: '/tmp', scanMode: '', comment: 'why' }
    expect(scanningExclusionMatches(spec, { type: 'path', value: '/tmp', scanMode: 'onDemandAndOnAccess', comment: 'why' })).toBe(true)
  })

  it('scanningExclusionMatches compares scanMode when the spec sets one', () => {
    const spec = { itemName: 'x', type: 'path', value: '/tmp', scanMode: 'onAccess', comment: 'why' }
    expect(scanningExclusionMatches(spec, { type: 'path', value: '/tmp', scanMode: 'onDemand', comment: 'why' })).toBe(false)
  })
})
