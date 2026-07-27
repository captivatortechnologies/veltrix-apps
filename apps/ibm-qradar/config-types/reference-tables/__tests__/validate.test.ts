import validate, { parseColumns, parseCells, extractReferenceTableSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('reference-tables validate', () => {
  it('accepts a valid reference table', () => {
    const r = validate(ctxWith([{ name: 'Users', fields: { name: 'Users', elementType: 'ALN', columns: 'srcip: IP\nrole: ALN', cells: 'alice | srcip = 10.0.0.1\nalice | role = admin' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { elementType: 'ALN' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires an inner key for each cell', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', elementType: 'ALN', cells: 'outer = value' } }]))
    expect(r.errors.some((e) => e.code === 'missing_inner_key')).toBe(true)
  })

  it('requires a value for each cell', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', elementType: 'ALN', cells: 'outer | inner =' } }]))
    expect(r.errors.some((e) => e.code === 'missing_value')).toBe(true)
  })

  it('rejects a duplicate cell', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', elementType: 'ALN', cells: 'o | i = 1\no | i = 2' } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_cell')).toBe(true)
  })

  it('rejects an invalid column type', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', elementType: 'ALN', columns: 'col: CIDR', cells: 'o | col = 1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_column_type')).toBe(true)
  })

  it('rejects an invalid element type', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', elementType: 'CIDR', cells: 'o | i = 1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_element_type')).toBe(true)
  })

  it('warns on an empty reference table', () => {
    const r = validate(ctxWith([{ name: 'E', fields: { name: 'E', elementType: 'ALN' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_table')).toBe(true)
  })
})

describe('parseColumns', () => {
  it('parses "name: TYPE" and uppercases the type', () => {
    expect(parseColumns('srcip: ip\nrole: ALN')).toEqual([{ name: 'srcip', type: 'IP' }, { name: 'role', type: 'ALN' }])
  })
})

describe('parseCells', () => {
  it('parses "outerKey | innerKey = value"', () => {
    expect(parseCells('alice | role = admin\nbob | ip = 10.0.0.2')).toEqual([
      { outerKey: 'alice', innerKey: 'role', value: 'admin' },
      { outerKey: 'bob', innerKey: 'ip', value: '10.0.0.2' },
    ])
  })
})

describe('extractReferenceTableSpecs', () => {
  it('uppercases the element type', () => {
    const specs = extractReferenceTableSpecs({
      items: [{ id: 'i1', name: 'T', fields: { name: 'T', elementType: 'ip', cells: 'o | i = v' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].elementType).toBe('IP')
  })
})
