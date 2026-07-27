import validate, { canonical, parseArray } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('entitlement-connected-organizations validate', () => {
  it('accepts a valid organization', () => {
    const r = validate(ctxWith([{ fields: { name: 'Contoso', state: 'configured', identitySources: '[]' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ fields: { state: 'configured' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid state', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', state: 'active' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_state')).toBe(true)
  })

  it('rejects invalid identity sources JSON', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', identitySources: '{not array' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })
})

describe('helpers', () => {
  it('canonicalizes arrays regardless of key order', () => {
    const a = parseArray('[{"a":1,"b":2}]') ?? []
    const b = parseArray('[{"b":2,"a":1}]') ?? []
    expect(canonical(a)).toBe(canonical(b))
  })
})
