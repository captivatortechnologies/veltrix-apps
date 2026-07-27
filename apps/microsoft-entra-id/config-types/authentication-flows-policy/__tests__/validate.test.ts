import validate, { extractAuthFlowsSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('authentication-flows-policy validate', () => {
  it('accepts a single policy', () => {
    const r = validate(ctxWith([{ fields: { selfServiceSignUpEnabled: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('rejects more than one item', () => {
    const r = validate(ctxWith([{ fields: {} }, { fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('reads the toggle as a real boolean', () => {
    const specs = extractAuthFlowsSpecs({ items: [{ fields: { selfServiceSignUpEnabled: true } }] } as never)
    expect(specs[0].selfServiceSignUpEnabled).toBe(true)
  })
})
