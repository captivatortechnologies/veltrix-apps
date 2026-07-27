import validate, { resultingId } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('b2x-user-flows validate', () => {
  it('accepts a valid flow', () => {
    const r = validate(ctxWith([{ fields: { id: 'PartnerSignUp', userFlowTypeVersion: 1 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an id', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an id with underscores/spaces', () => {
    const r = validate(ctxWith([{ fields: { id: 'my_flow' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_id')).toBe(true)
  })

  it('rejects duplicate ids', () => {
    const r = validate(ctxWith([{ fields: { id: 'Dup' } }, { fields: { id: 'Dup' } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_id')).toBe(true)
  })

  it('prefixes the resulting id', () => {
    expect(resultingId('PartnerSignUp')).toBe('B2X_1_PartnerSignUp')
  })
})
