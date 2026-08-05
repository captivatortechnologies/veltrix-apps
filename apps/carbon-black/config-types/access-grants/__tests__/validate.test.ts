import validate, { extractGrantSpecs, splitRoles, ROLE_URN_RE } from '../validate'
import { union } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('access-grants validate', () => {
  it('accepts a valid grant', () => {
    const r = validate(
      ctxWith([{ name: 'G', fields: { principalEmail: 'demo@broadcom.com', roles: 'psc:role::SECOPS_ROLE_MANAGER' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a custom org-scoped role URN', () => {
    const r = validate(
      ctxWith([{ name: 'G', fields: { principalEmail: 'demo@broadcom.com', roles: 'psc:role:ABCD1234:CUSTOM_ROLE' } }])
    )
    expect(r.valid).toBe(true)
  })

  it('requires a principal email', () => {
    const r = validate(ctxWith([{ name: '', fields: { roles: 'psc:role::SECOPS_ROLE_MANAGER' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.includes('principalEmail'))).toBe(true)
  })

  it('rejects a malformed email', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { principalEmail: 'not-an-email', roles: 'psc:role::X' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('requires at least one role', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { principalEmail: 'demo@broadcom.com' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.includes('roles'))).toBe(true)
  })

  it('rejects a malformed role URN', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { principalEmail: 'demo@broadcom.com', roles: 'SECOPS_ROLE_MANAGER' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_role_urn')).toBe(true)
  })

  it('flags a duplicate principal (case-insensitive)', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { principalEmail: 'demo@broadcom.com', roles: 'psc:role::X' } },
        { name: 'B', fields: { principalEmail: 'DEMO@broadcom.com', roles: 'psc:role::Y' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_principal')).toBe(true)
  })
})

describe('extractGrantSpecs / splitRoles', () => {
  it('lower-cases the principal email and dedupes multi-line roles', () => {
    const specs = extractGrantSpecs(
      ctxWith([{ name: 'G', fields: { principalEmail: 'Demo@Broadcom.com', roles: 'psc:role::A\npsc:role::B\npsc:role::A' } }]).canvas
    )
    expect(specs[0].principalEmail).toBe('demo@broadcom.com')
    expect(specs[0].roles).toEqual(['psc:role::A', 'psc:role::B'])
  })

  it('splitRoles accepts comma-separated input too', () => {
    expect(splitRoles('psc:role::A, psc:role::B')).toEqual(['psc:role::A', 'psc:role::B'])
  })
})

describe('ROLE_URN_RE', () => {
  it('matches built-in and custom role URNs', () => {
    expect(ROLE_URN_RE.test('psc:role::SECOPS_ROLE_MANAGER')).toBe(true)
    expect(ROLE_URN_RE.test('psc:role:ABCD1234:CUSTOM_ROLE')).toBe(true)
  })

  it('rejects a bare role name or malformed URN', () => {
    expect(ROLE_URN_RE.test('SECOPS_ROLE_MANAGER')).toBe(false)
    expect(ROLE_URN_RE.test('psc:role:')).toBe(false)
  })
})

describe('union', () => {
  it('merges two role arrays without duplicates', () => {
    expect(union(['psc:role::A'], ['psc:role::A', 'psc:role::B'])).toEqual(['psc:role::A', 'psc:role::B'])
  })

  it('is additive when the existing set is empty', () => {
    expect(union([], ['psc:role::A'])).toEqual(['psc:role::A'])
  })
})
