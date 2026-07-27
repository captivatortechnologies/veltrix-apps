import validate, { extractAuthMethodSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('authentication-methods-policy validate', () => {
  it('accepts a valid method + state', () => {
    const r = validate(ctxWith([{ fields: { method: 'fido2', state: 'enabled' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('rejects an unknown method', () => {
    const r = validate(ctxWith([{ fields: { method: 'telepathy', state: 'enabled' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_method')).toBe(true)
  })

  it('rejects an invalid state', () => {
    const r = validate(ctxWith([{ fields: { method: 'email', state: 'maybe' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_state')).toBe(true)
  })

  it('rejects duplicate methods', () => {
    const r = validate(
      ctxWith([
        { fields: { method: 'sms', state: 'enabled' } },
        { fields: { method: 'sms', state: 'disabled' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_method')).toBe(true)
  })

  it('defaults an absent state to disabled', () => {
    const specs = extractAuthMethodSpecs({ items: [{ fields: { method: 'voice' } }] } as never)
    expect(specs[0].state).toBe('disabled')
  })
})
