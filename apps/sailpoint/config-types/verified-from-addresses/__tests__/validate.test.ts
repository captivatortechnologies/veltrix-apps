import validate, { extractVerifiedFromAddressSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('verified-from-addresses validate', () => {
  it('accepts a valid email', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { email: 'noreply@acme.com' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an email', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a malformed email', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { email: 'not-an-email' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('rejects duplicate emails', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { email: 'x@acme.com' } },
        { name: 'b', fields: { email: 'x@acme.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_email')).toBe(true)
  })
})

describe('extractVerifiedFromAddressSpecs', () => {
  it('reads the email field', () => {
    const specs = extractVerifiedFromAddressSpecs({
      items: [{ id: 'i1', name: 'a', fields: { email: 'noreply@acme.com' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].email).toBe('noreply@acme.com')
  })
})
