import validate, { parseTimeRange, extractSavedSearchSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const TR = '{"type":"relative","value":{"amount":24,"unit":"hour"}}'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('saved-searches validate', () => {
  it('accepts a valid saved search', () => {
    const r = validate(ctxWith([{ name: 'Public buckets', fields: { name: 'Public buckets', query: 'config from cloud.resource', timeRange: TR } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { query: 'config from x', timeRange: TR } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires a query', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', timeRange: TR } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.query'))).toBe(true)
  })

  it('requires a time range', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', query: 'config from x' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.timeRange'))).toBe(true)
  })

  it('rejects invalid time range JSON', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', query: 'config from x', timeRange: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_time_range')).toBe(true)
  })

  it('rejects an invalid cloud type', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', query: 'config from x', cloudType: 'ibm', timeRange: TR } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cloud_type')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', query: 'config from x', timeRange: TR } },
        { name: 'Dup', fields: { name: 'Dup', query: 'config from x', timeRange: TR } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseTimeRange', () => {
  it('parses a JSON object string', () => {
    expect(parseTimeRange(TR).timeRange).toEqual({ type: 'relative', value: { amount: 24, unit: 'hour' } })
  })

  it('flags an array JSON value', () => {
    expect(parseTimeRange('[1,2]').timeRangeError).toBe('Time range must be a JSON object')
  })
})

describe('extractSavedSearchSpecs', () => {
  it('defaults searchType to config', () => {
    const specs = extractSavedSearchSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', query: 'config from x', timeRange: TR } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].searchType).toBe('config')
  })
})
