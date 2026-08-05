import validate, { parseLookupEntries, extractArielLookupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('ariel-lookups validate', () => {
  it('accepts a valid lookup', () => {
    const r = validate(ctxWith([{ name: 'Severity', fields: { name: 'Severity', type: 'String', entries: '1=Low\n2=High' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'String' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'Severity', fields: { name: 'Severity', type: 'String' } },
      { name: 'severity', fields: { name: 'severity', type: 'String' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an invalid field type', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', type: 'Nonsense', entries: 'a=1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_field_type')).toBe(true)
  })

  it('rejects a duplicate key', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', type: 'String', entries: 'a=1\na=2' } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_key')).toBe(true)
  })

  it('warns on an empty lookup with no default', () => {
    const r = validate(ctxWith([{ name: 'Empty', fields: { name: 'Empty', type: 'String' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_lookup')).toBe(true)
  })

  it('does not warn when a default value is set', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { name: 'D', type: 'String', defaultValue: 'Unknown' } }]))
    expect(r.warnings.some((w) => w.code === 'empty_lookup')).toBe(false)
  })
})

describe('parseLookupEntries', () => {
  it('splits key=value on the first equals', () => {
    expect(parseLookupEntries('1=Low\n2=High=est')).toEqual([{ key: '1', value: 'Low' }, { key: '2', value: 'High=est' }])
    expect(parseLookupEntries('')).toEqual([])
  })
})

describe('extractArielLookupSpecs', () => {
  it('defaults the type to String', () => {
    const specs = extractArielLookupSpecs({
      items: [{ id: 'i1', name: 'M', fields: { name: 'M' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('String')
  })
})
