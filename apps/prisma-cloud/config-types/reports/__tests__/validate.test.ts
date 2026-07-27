import validate, { parseTarget, extractReportSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const TARGET = '{"accountGroups":["ag-1"],"timeRange":{"type":"to_now","value":"epoch"}}'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('reports validate', () => {
  it('accepts a valid report', () => {
    const r = validate(ctxWith([{ name: 'Monthly CIS', fields: { name: 'Monthly CIS', reportType: 'INVENTORY_OVERVIEW', target: TARGET } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { reportType: 'RIS', target: TARGET } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires a report type', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', target: TARGET } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.reportType'))).toBe(true)
  })

  it('rejects an invalid cloud type', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', reportType: 'RIS', cloudType: 'ibm', target: TARGET } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cloud_type')).toBe(true)
  })

  it('rejects invalid target JSON', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', reportType: 'RIS', target: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_target')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', reportType: 'RIS', target: TARGET } },
        { name: 'Dup', fields: { name: 'Dup', reportType: 'RIS', target: TARGET } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseTarget', () => {
  it('parses a JSON object string', () => {
    expect(parseTarget('{"a":1}').target).toEqual({ a: 1 })
  })

  it('flags an array JSON value', () => {
    expect(parseTarget('[1,2]').targetError).toBe('Target must be a JSON object')
  })
})

describe('extractReportSpecs', () => {
  it('parses fields', () => {
    const specs = extractReportSpecs({
      items: [{ id: 'i1', name: 'R', fields: { name: 'R', reportType: 'RIS', target: TARGET } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].reportType).toBe('RIS')
  })
})
