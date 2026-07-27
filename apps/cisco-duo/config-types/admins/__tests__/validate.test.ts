import validate, { extractAdminSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('admins validate', () => {
  it('accepts a valid administrator', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { email: 'a@example.com', name: 'Alice', role: 'Administrator' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an email', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { name: 'Alice', role: 'Read-only' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.email'))).toBe(true)
  })

  it('rejects a malformed email', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { email: 'not-an-email', name: 'A', role: 'Read-only' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('rejects an unknown role', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { email: 'a@example.com', name: 'A', role: 'Superuser' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_role')).toBe(true)
  })

  it('rejects duplicate emails (case-insensitive)', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { email: 'Dup@example.com', name: 'A', role: 'Read-only' } },
        { name: 'b', fields: { email: 'dup@example.com', name: 'B', role: 'Read-only' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_email')).toBe(true)
  })

  it('warns when declaring an Owner', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { email: 'o@example.com', name: 'Owner', role: 'Owner' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'owner_role')).toBe(true)
  })
})

describe('extractAdminSpecs', () => {
  it('lowercases the email and trims, defaulting the role', () => {
    const specs = extractAdminSpecs({
      items: [{ id: 'i1', name: 'Fallback', fields: { email: '  A@Example.com ', name: ' Alice ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', email: 'a@example.com', name: 'Alice', role: 'Read-only' })
  })
})
