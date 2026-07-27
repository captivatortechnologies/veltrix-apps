import validate, { isValidDateTime, extractOnetimeScheduleSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-schedules-onetime validate', () => {
  it('accepts a valid window', () => {
    const r = validate(ctxWith([{ name: 'Maint', fields: { name: 'Maint', start: '08:00 2026/01/01', end: '18:00 2026/01/07' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { start: '08:00 2026/01/01', end: '18:00 2026/01/07' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid date-time', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', start: '2026/01/01 08:00', end: '18:00 2026/13/40' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_datetime')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', start: '08:00 2026/01/01', end: '18:00 2026/01/07' } },
        { name: 'Dup', fields: { name: 'Dup', start: '08:00 2026/02/01', end: '18:00 2026/02/07' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('isValidDateTime', () => {
  it('validates hh:mm yyyy/mm/dd', () => {
    expect(isValidDateTime('08:00 2026/01/01')).toBe(true)
    expect(isValidDateTime('23:59 2026/12/31')).toBe(true)
    expect(isValidDateTime('24:00 2026/01/01')).toBe(false)
    expect(isValidDateTime('08:00 2026/13/01')).toBe(false)
    expect(isValidDateTime('2026/01/01 08:00')).toBe(false)
  })
})

describe('extractOnetimeScheduleSpecs', () => {
  it('trims fields', () => {
    const specs = extractOnetimeScheduleSpecs({
      items: [{ id: 'i1', name: 'M', fields: { name: 'M', start: ' 08:00 2026/01/01 ', end: '18:00 2026/01/07' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].start).toBe('08:00 2026/01/01')
  })
})
