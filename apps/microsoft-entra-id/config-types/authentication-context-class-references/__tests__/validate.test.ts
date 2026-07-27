import validate, { extractAuthContextSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('authentication-context validate', () => {
  it('accepts a valid context', () => {
    const r = validate(ctxWith([{ name: 'c1', fields: { contextId: 'c1', displayName: 'High trust' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a context id', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { displayName: 'x' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an out-of-range context id', () => {
    const r = validate(ctxWith([{ name: 'c99', fields: { contextId: 'c99', displayName: 'x' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_context_id')).toBe(true)
  })

  it('requires a display name', () => {
    const r = validate(ctxWith([{ name: '', fields: { contextId: 'c2', displayName: '' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate context ids', () => {
    const r = validate(
      ctxWith([
        { name: 'c3', fields: { contextId: 'c3', displayName: 'A' } },
        { name: 'c3', fields: { contextId: 'c3', displayName: 'B' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_context_id')).toBe(true)
  })
})

describe('extractAuthContextSpecs', () => {
  it('lowercases the context id', () => {
    const specs = extractAuthContextSpecs({ items: [{ name: 'x', fields: { contextId: 'C5', displayName: 'y' } }] } as never)
    expect(specs[0].contextId).toBe('c5')
  })
})
