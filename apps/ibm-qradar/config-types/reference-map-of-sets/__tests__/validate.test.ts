import validate, { parseEntries, extractMapOfSetsSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('reference-map-of-sets validate', () => {
  it('accepts a valid map-of-sets', () => {
    const r = validate(ctxWith([{ name: 'Groups', fields: { name: 'Groups', elementType: 'IP', entries: 'trusted = 10.0.0.1, 10.0.0.2\nblocked = 5.6.7.8' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { elementType: 'ALN' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires values for each key', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', elementType: 'ALN', entries: 'keyonly =' } }]))
    expect(r.errors.some((e) => e.code === 'missing_values')).toBe(true)
  })

  it('rejects a duplicate key', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', elementType: 'ALN', entries: 'a = 1\na = 2' } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_key')).toBe(true)
  })

  it('rejects an invalid element type', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', elementType: 'CIDR', entries: 'a = 1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_element_type')).toBe(true)
  })

  it('warns on an empty map-of-sets', () => {
    const r = validate(ctxWith([{ name: 'E', fields: { name: 'E', elementType: 'ALN' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_map')).toBe(true)
  })
})

describe('parseEntries', () => {
  it('parses key = value, value into a set', () => {
    expect(parseEntries('a = 1, 2, 1\nb = x')).toEqual([{ key: 'a', values: ['1', '2'] }, { key: 'b', values: ['x'] }])
  })
})

describe('extractMapOfSetsSpecs', () => {
  it('uppercases the element type', () => {
    const specs = extractMapOfSetsSpecs({
      items: [{ id: 'i1', name: 'M', fields: { name: 'M', elementType: 'ip', entries: 'k = v' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].elementType).toBe('IP')
  })
})
