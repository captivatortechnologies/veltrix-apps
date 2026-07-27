import validate, { splitDays, isValidTime, extractRecurringScheduleSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-schedules-recurring validate', () => {
  it('accepts a valid weekday schedule', () => {
    const r = validate(ctxWith([{ name: 'Work', fields: { name: 'Work', days: 'monday\ntuesday\nfriday', start: '09:00', end: '17:00' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { days: 'monday', start: '09:00', end: '17:00' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one day', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', start: '09:00', end: '17:00' } }]))
    expect(r.errors.some((e) => e.code === 'missing_days')).toBe(true)
  })

  it('rejects an invalid day', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', days: 'funday', start: '09:00', end: '17:00' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_day')).toBe(true)
  })

  it('rejects an invalid time', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', days: 'monday', start: '25:00', end: '17:60' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_time')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', days: 'monday', start: '09:00', end: '17:00' } },
        { name: 'Dup', fields: { name: 'Dup', days: 'tuesday', start: '09:00', end: '17:00' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitDays / isValidTime', () => {
  it('splits, lowercases and de-duplicates days', () => {
    expect(splitDays('Monday\nTUESDAY, monday')).toEqual(['monday', 'tuesday'])
  })
  it('validates hh:mm times', () => {
    expect(isValidTime('09:00')).toBe(true)
    expect(isValidTime('23:59')).toBe(true)
    expect(isValidTime('24:00')).toBe(false)
    expect(isValidTime('9')).toBe(false)
  })
})

describe('extractRecurringScheduleSpecs', () => {
  it('parses days', () => {
    const specs = extractRecurringScheduleSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', days: 'monday friday', start: '08:00', end: '18:00' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].days).toEqual(['monday', 'friday'])
  })
})
