import validate, { extractSearchAttributeSpecs, toStringMap } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('search-attribute-config validate', () => {
  it('accepts a valid search attribute', () => {
    const r = validate(ctxWith([{ name: 'costCenter', fields: { name: 'costCenter', displayName: 'Cost Center', applicationAttributes: { src1: 'cc' } } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('warns when no source attributes are mapped', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { name: 'x' } }]))
    expect(r.warnings.some((w) => w.code === 'no_mappings')).toBe(true)
  })
})

describe('toStringMap / extract', () => {
  it('coerces a keyvalue object to a string map', () => {
    expect(toStringMap({ a: 'b', c: 1 })).toEqual({ a: 'b', c: '1' })
  })

  it('reads the applicationAttributes map', () => {
    const specs = extractSearchAttributeSpecs({
      items: [{ id: 'i1', name: 'x', fields: { name: 'x', applicationAttributes: { s: 'attr' } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].applicationAttributes).toEqual({ s: 'attr' })
  })
})
