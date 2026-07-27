import validate, { canonical, parseObject } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('app-management-policies validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(
      ctxWith([{ name: 'Cred hygiene', fields: { name: 'Cred hygiene', restrictions: '{"passwordCredentials":[]}' } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid restrictions JSON', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', restrictions: '{not json' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('helpers', () => {
  it('treats an empty string as an empty object', () => {
    expect(parseObject('')).toEqual({})
  })

  it('rejects a JSON array', () => {
    expect(parseObject('[1,2]')).toBe(null)
  })

  it('canonicalizes equal objects regardless of key order', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
  })
})
