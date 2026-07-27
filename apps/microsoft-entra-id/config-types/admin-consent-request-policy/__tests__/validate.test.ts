import validate, { canonical, extractAdminConsentRequestSpecs, parseArray } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('admin-consent-request-policy validate', () => {
  it('accepts a disabled policy with empty reviewers', () => {
    const r = validate(ctxWith([{ fields: { isEnabled: false, requestDurationInDays: 30, reviewers: '[]' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings).toHaveLength(0)
  })

  it('rejects a non-positive duration', () => {
    const r = validate(ctxWith([{ fields: { requestDurationInDays: 0, reviewers: '[]' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('rejects invalid reviewers JSON', () => {
    const r = validate(ctxWith([{ fields: { requestDurationInDays: 5, reviewers: '{not array' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('warns when enabled with no reviewers', () => {
    const r = validate(ctxWith([{ fields: { isEnabled: true, requestDurationInDays: 5, reviewers: '[]' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_reviewers')).toBe(true)
  })

  it('rejects more than one item', () => {
    const r = validate(ctxWith([{ fields: { requestDurationInDays: 5 } }, { fields: { requestDurationInDays: 5 } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('coerces number and boolean fields', () => {
    const specs = extractAdminConsentRequestSpecs({
      items: [{ fields: { isEnabled: true, requestDurationInDays: '7' } }],
    } as never)
    expect(specs[0].requestDurationInDays).toBe(7)
    expect(specs[0].isEnabled).toBe(true)
  })
})

describe('helpers', () => {
  it('parses arrays and rejects non-arrays', () => {
    expect(parseArray('[]')).toEqual([])
    expect(parseArray('{}')).toBe(null)
  })

  it('canonicalizes equal arrays regardless of key order', () => {
    expect(canonical([{ a: 1, b: 2 }])).toBe(canonical([{ b: 2, a: 1 }]))
  })
})
