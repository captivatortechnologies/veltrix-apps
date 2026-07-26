import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('named-locations validate', () => {
  it('accepts a valid IP named location', () => {
    const r = validate(
      ctxWith([{ name: 'Corp', fields: { type: 'ip', name: 'Corp', ipRanges: '203.0.113.0/24' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid country named location', () => {
    const r = validate(
      ctxWith([{ name: 'NA', fields: { type: 'country', name: 'NA', countries: 'US, CA' } }])
    )
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'ip', ipRanges: '10.0.0.0/8' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid CIDR', () => {
    const r = validate(
      ctxWith([{ name: 'Bad', fields: { type: 'ip', name: 'Bad', ipRanges: '999.0.0.0/24' } }])
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects an invalid ISO country code', () => {
    const r = validate(
      ctxWith([{ name: 'X', fields: { type: 'country', name: 'X', countries: 'USA' } }])
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_country')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { type: 'ip', name: 'Dup', ipRanges: '10.0.0.0/8' } },
        { name: 'Dup', fields: { type: 'ip', name: 'Dup', ipRanges: '10.0.0.0/8' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires ranges for ip and countries for country', () => {
    const ip = validate(ctxWith([{ name: 'E', fields: { type: 'ip', name: 'E' } }]))
    expect(ip.errors.some((e) => e.code === 'missing_ranges')).toBe(true)
    const country = validate(ctxWith([{ name: 'E', fields: { type: 'country', name: 'E' } }]))
    expect(country.errors.some((e) => e.code === 'missing_countries')).toBe(true)
  })
})
