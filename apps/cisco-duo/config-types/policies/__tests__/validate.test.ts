import validate, { extractPolicySpecs, parseSections } from '../validate'
import { canonicalJson, sha512Hex } from '../../../lib/duo'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('policies validate', () => {
  it('accepts a valid policy with JSON sections', () => {
    const r = validate(
      ctxWith([{ name: 'Bypass MFA', fields: { name: 'Bypass MFA', sections: '{"browsers":{"blocked_browsers_list":[]}}' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a policy with empty sections', () => {
    const r = validate(ctxWith([{ name: 'Empty', fields: { name: 'Empty', sections: '' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { sections: '{}' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects invalid sections JSON', () => {
    const r = validate(ctxWith([{ name: 'Bad', fields: { name: 'Bad', sections: '{not json' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a section whose value is not an object', () => {
    const r = validate(ctxWith([{ name: 'Scalar', fields: { name: 'Scalar', sections: '{"browsers":true}' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'section_not_object')).toBe(true)
  })

  it('rejects more than one Global Policy', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { name: 'A', is_global: true } },
        { name: 'B', fields: { name: 'B', is_global: true } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_global')).toBe(true)
  })
})

describe('extractPolicySpecs', () => {
  it('reads name, is_global and raw sections', () => {
    const specs = extractPolicySpecs({
      items: [{ id: 'i1', name: 'Fallback', fields: { name: '  Real  ', is_global: true, sections: '{"a":{}}' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'Real', isGlobal: true, sectionsRaw: '{"a":{}}' })
  })
})

describe('parseSections', () => {
  it('treats blank as an empty object', () => {
    const r = parseSections('')
    expect(r.ok).toBe(true)
    expect(r.value).toEqual({})
  })

  it('rejects a JSON array', () => {
    expect(parseSections('[]').ok).toBe(false)
  })
})

describe('duo V5 signing helpers', () => {
  it('canonicalizes JSON with recursively sorted keys and compact separators', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(canonicalJson({ z: [{ y: 1, x: 2 }] })).toBe('{"z":[{"x":2,"y":1}]}')
  })

  it('computes the empty-body SHA-512 constant', () => {
    expect(sha512Hex('')).toBe(
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'
    )
  })
})
