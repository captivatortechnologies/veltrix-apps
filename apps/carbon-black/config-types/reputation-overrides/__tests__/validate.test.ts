import validate, { naturalKey, liveNaturalKey, extractOverrideSpecs } from '../validate'
import { definitionEquals, buildBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

describe('reputation-overrides validate', () => {
  it('accepts a valid SHA256 ban', () => {
    const r = validate(ctxWith([{ name: 'Bad', fields: { label: 'Bad exe', overrideList: 'BLACK_LIST', overrideType: 'SHA256', sha256Hash: HASH } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts CERT and IT_TOOL overrides', () => {
    const cert = validate(ctxWith([{ name: 'C', fields: { label: 'Vendor', overrideList: 'WHITE_LIST', overrideType: 'CERT', signedBy: 'VMware Inc.' } }]))
    expect(cert.valid).toBe(true)
    const tool = validate(ctxWith([{ name: 'T', fields: { label: 'Tool', overrideList: 'WHITE_LIST', overrideType: 'IT_TOOL', path: 'C://tools//*.exe' } }]))
    expect(tool.valid).toBe(true)
  })

  it('requires a label', () => {
    const r = validate(ctxWith([{ name: '', fields: { overrideType: 'SHA256', sha256Hash: HASH } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a bad sha256 hash', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { label: 'X', overrideType: 'SHA256', sha256Hash: 'nothex' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_hash')).toBe(true)
  })

  it('requires the type-specific identifier', () => {
    const cert = validate(ctxWith([{ name: 'C', fields: { label: 'C', overrideType: 'CERT' } }]))
    expect(cert.errors.some((e) => e.code === 'missing_signed_by')).toBe(true)
    const tool = validate(ctxWith([{ name: 'T', fields: { label: 'T', overrideType: 'IT_TOOL' } }]))
    expect(tool.errors.some((e) => e.code === 'missing_path')).toBe(true)
  })

  it('rejects two items targeting the same override', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { label: 'A', overrideType: 'SHA256', sha256Hash: HASH } },
        { name: 'B', fields: { label: 'B', overrideType: 'SHA256', sha256Hash: HASH } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_override')).toBe(true)
  })
})

describe('naturalKey / liveNaturalKey', () => {
  it('produces matching keys for a spec and its live form', () => {
    const specs = extractOverrideSpecs(
      ctxWith([{ name: 'A', fields: { label: 'A', overrideType: 'SHA256', sha256Hash: HASH.toUpperCase() } }]).canvas
    )
    expect(naturalKey(specs[0])).toBe(`sha256:${HASH.toLowerCase()}`)
    expect(liveNaturalKey({ override_type: 'SHA256', sha256_hash: HASH })).toBe(`sha256:${HASH.toLowerCase()}`)
  })
})

describe('definitionEquals / buildBody', () => {
  it('detects a changed list as unequal', () => {
    const spec = extractOverrideSpecs(
      ctxWith([{ name: 'A', fields: { label: 'A', overrideList: 'WHITE_LIST', overrideType: 'SHA256', sha256Hash: HASH } }]).canvas
    )[0]
    expect(definitionEquals({ override_list: 'WHITE_LIST', override_type: 'SHA256', sha256_hash: HASH }, spec)).toBe(true)
    expect(definitionEquals({ override_list: 'BLACK_LIST', override_type: 'SHA256', sha256_hash: HASH }, spec)).toBe(false)
    const body = buildBody(spec)
    expect(body.override_list).toBe('WHITE_LIST')
    expect(body.override_type).toBe('SHA256')
    expect(body.sha256_hash).toBe(HASH.toLowerCase())
  })
})
