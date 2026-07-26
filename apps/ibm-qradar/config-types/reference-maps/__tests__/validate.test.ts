import validate, { parseEntries, extractReferenceMapSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('reference-maps validate', () => {
  it('accepts a valid map', () => {
    const r = validate(ctxWith([{ name: 'HostMap', fields: { name: 'HostMap', elementType: 'ALN', entries: '10.0.0.1=web\n10.0.0.2=db' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { elementType: 'ALN' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an entry without a value', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', elementType: 'ALN', entries: 'keyonly' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value')).toBe(true)
  })

  it('rejects a duplicate key', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', elementType: 'ALN', entries: 'a=1\na=2' } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_key')).toBe(true)
  })

  it('rejects an invalid element type', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', elementType: 'CIDR', entries: 'a=1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_element_type')).toBe(true)
  })

  it('warns on an empty map', () => {
    const r = validate(ctxWith([{ name: 'E', fields: { name: 'E', elementType: 'ALN' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_map')).toBe(true)
  })
})

describe('parseEntries', () => {
  it('splits key=value on the first equals', () => {
    expect(parseEntries('a=1\nb=x=y')).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: 'x=y' }])
    expect(parseEntries('')).toEqual([])
  })
})

describe('extractReferenceMapSpecs', () => {
  it('uppercases the element type', () => {
    const specs = extractReferenceMapSpecs({
      items: [{ id: 'i1', name: 'M', fields: { name: 'M', elementType: 'ip', entries: 'k=v' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].elementType).toBe('IP')
  })
})
