import validate, { canonical } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const SCOPE = '{"query":"/groups/x/transitiveMembers","queryType":"MicrosoftGraph"}'
const REVIEWERS = '[{"query":"/users/y","queryType":"MicrosoftGraph"}]'
const SETTINGS = '{"instanceDurationInDays":7}'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('access-review-definitions validate', () => {
  it('accepts a valid definition', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'Quarterly', scope: SCOPE, reviewers: REVIEWERS, settings: SETTINGS } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires scope, reviewers and settings', () => {
    const r = validate(ctxWith([{ fields: { name: 'X' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_scope')).toBe(true)
    expect(r.errors.some((e) => e.code === 'invalid_reviewers')).toBe(true)
    expect(r.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects a non-array reviewers', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', scope: SCOPE, reviewers: '{}', settings: SETTINGS } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_reviewers')).toBe(true)
  })
})

describe('helpers', () => {
  it('canonicalizes objects independent of key order', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
  })
})
