import validate, { splitValues, extractReferenceSetSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('reference-sets validate', () => {
  it('accepts a valid ALN set', () => {
    const r = validate(ctxWith([{ name: 'Domains', fields: { name: 'Domains', elementType: 'ALN', values: 'a.com\nb.com' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid IP set', () => {
    const r = validate(ctxWith([{ name: 'IPs', fields: { name: 'IPs', elementType: 'IP', values: '10.0.0.1\n10.0.0.2' } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects an invalid IP in an IP set', () => {
    const r = validate(ctxWith([{ name: 'IPs', fields: { name: 'IPs', elementType: 'IP', values: '999.0.0.1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('rejects a non-numeric value in a NUM set', () => {
    const r = validate(ctxWith([{ name: 'N', fields: { name: 'N', elementType: 'NUM', values: 'abc' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { elementType: 'ALN' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid element type', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', elementType: 'CIDR' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_element_type')).toBe(true)
  })

  it('warns on an empty set', () => {
    const r = validate(ctxWith([{ name: 'E', fields: { name: 'E', elementType: 'ALN' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_set')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', elementType: 'ALN', values: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', elementType: 'ALN', values: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitValues', () => {
  it('splits, trims and de-duplicates', () => {
    expect(splitValues('a\nb, a')).toEqual(['a', 'b'])
    expect(splitValues(['x', ' x ', 'y'])).toEqual(['x', 'y'])
    expect(splitValues('')).toEqual([])
  })
})

describe('extractReferenceSetSpecs', () => {
  it('uppercases the element type', () => {
    const specs = extractReferenceSetSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', elementType: 'ip', values: '10.0.0.1' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].elementType).toBe('IP')
  })
})
