import validate, { splitIds, extractUserSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const VALID_FIELDS = {
  email: 'auditor@example.com',
  firstName: 'Ada',
  lastName: 'Auditor',
  timeZone: 'America/Los_Angeles',
  defaultRoleId: 'role-1',
  roleIds: 'role-1\nrole-2',
}

describe('users validate', () => {
  it('accepts a valid user', () => {
    const r = validate(ctxWith([{ name: 'auditor@example.com', fields: VALID_FIELDS }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an email', () => {
    const r = validate(ctxWith([{ name: '', fields: { ...VALID_FIELDS, email: '' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.email'))).toBe(true)
  })

  it('rejects a malformed email', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { ...VALID_FIELDS, email: 'not-an-email' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('rejects duplicate emails (case-insensitive)', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { ...VALID_FIELDS, email: 'Dup@example.com' } },
        { name: 'b', fields: { ...VALID_FIELDS, email: 'dup@example.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_email')).toBe(true)
  })

  it('requires firstName and lastName', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { ...VALID_FIELDS, firstName: '', lastName: '' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.firstName'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.lastName'))).toBe(true)
  })

  it('requires a time zone', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { ...VALID_FIELDS, timeZone: '' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.timeZone'))).toBe(true)
  })

  it('requires at least one role id', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { ...VALID_FIELDS, roleIds: '' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.roleIds'))).toBe(true)
  })

  it('requires defaultRoleId to be one of roleIds', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { ...VALID_FIELDS, defaultRoleId: 'role-9', roleIds: 'role-1\nrole-2' } }]))
    expect(r.errors.some((e) => e.code === 'default_role_not_in_role_ids')).toBe(true)
  })
})

describe('splitIds', () => {
  it('splits, trims and de-duplicates', () => {
    expect(splitIds('a\nb, a')).toEqual(['a', 'b'])
    expect(splitIds('')).toEqual([])
  })
})

describe('extractUserSpecs', () => {
  it('defaults accessKeysAllowed to false and enabled to true', () => {
    const specs = extractUserSpecs({
      items: [{ id: 'i1', name: 'x', fields: VALID_FIELDS }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].accessKeysAllowed).toBe(false)
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].roleIds).toEqual(['role-1', 'role-2'])
  })

  it('respects explicit false/true overrides', () => {
    const specs = extractUserSpecs({
      items: [{ id: 'i1', name: 'x', fields: { ...VALID_FIELDS, accessKeysAllowed: true, enabled: false } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].accessKeysAllowed).toBe(true)
    expect(specs[0].enabled).toBe(false)
  })
})
