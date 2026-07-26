import validate, { parseColumns, parseRows, extractDataTableSpecs } from '../validate'
import { buildColumnInfo, bulkReplaceBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('data-tables validate', () => {
  it('accepts a valid table', () => {
    const r = validate(ctxWith([{ name: 'blocked_users', fields: { name: 'blocked_users', description: 'd', columns: 'username, ip_address:CIDR', rows: 'alice,10.0.0.0/24\nbob,10.0.1.0/24' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, description and columns', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
    expect(r.errors.some((e) => e.code === 'missing_columns')).toBe(true)
  })

  it('rejects an invalid data table id', () => {
    const r = validate(ctxWith([{ name: '1bad', fields: { name: '1bad', description: 'd', columns: 'a' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects an invalid column type', () => {
    const r = validate(ctxWith([{ name: 't', fields: { name: 't', description: 'd', columns: 'a:WEIRD' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_column_type')).toBe(true)
  })

  it('rejects a row with the wrong number of values', () => {
    const r = validate(ctxWith([{ name: 't', fields: { name: 't', description: 'd', columns: 'a,b', rows: 'only-one' } }]))
    expect(r.errors.some((e) => e.code === 'row_arity')).toBe(true)
  })

  it('warns on an empty table', () => {
    const r = validate(ctxWith([{ name: 't', fields: { name: 't', description: 'd', columns: 'a' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_table')).toBe(true)
  })
})

describe('parseColumns / parseRows', () => {
  it('parses columns with default and explicit types', () => {
    expect(parseColumns('a, b:CIDR')).toEqual([{ name: 'a', type: 'STRING' }, { name: 'b', type: 'CIDR' }])
  })
  it('parses rows into positional cells', () => {
    expect(parseRows('x,y\nz,w')).toEqual([['x', 'y'], ['z', 'w']])
  })
})

describe('buildColumnInfo / bulkReplaceBody', () => {
  it('builds indexed column info', () => {
    const specs = extractDataTableSpecs(ctxWith([{ name: 't', fields: { name: 't', description: 'd', columns: 'a,b:NUMBER' } }]).canvas)
    const info = buildColumnInfo(specs[0].columns) as Array<{ columnIndex: number; originalColumn: string; columnType: string }>
    expect(info[0]).toEqual({ columnIndex: 0, originalColumn: 'a', columnType: 'STRING' })
    expect(info[1]).toEqual({ columnIndex: 1, originalColumn: 'b', columnType: 'NUMBER' })
  })
  it('wraps rows in bulkReplace requests', () => {
    const body = bulkReplaceBody([['x', 'y']]) as { requests: Array<{ dataTableRow: { values: string[] } }> }
    expect(body.requests[0].dataTableRow.values).toEqual(['x', 'y'])
  })
})
