import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('external-identity-providers validate', () => {
  it('accepts a valid provider', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Google', identityProviderType: 'Google', clientId: 'abc', clientSecret: 'shh' } },
      ]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, type, clientId and clientSecret', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'required').length).toBe(4)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Dup', identityProviderType: 'Google', clientId: 'a', clientSecret: 'b' } },
        { fields: { name: 'Dup', identityProviderType: 'Facebook', clientId: 'c', clientSecret: 'd' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})
