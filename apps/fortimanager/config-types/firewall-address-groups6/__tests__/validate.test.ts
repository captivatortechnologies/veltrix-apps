import validate, { splitMembers, liveMemberNames, extractAddressGroup6Specs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-address-groups6 validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'V6-Web', fields: { name: 'V6-Web', members: 'DMZ6\nAppTier6' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { members: 'a' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one member', () => {
    const r = validate(ctxWith([{ name: 'G6', fields: { name: 'G6' } }]))
    expect(r.errors.some((e) => e.code === 'missing_members')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup6', fields: { name: 'Dup6', members: 'a' } },
        { name: 'Dup6', fields: { name: 'Dup6', members: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a name over the max length', () => {
    const r = validate(ctxWith([{ name: 'Long6', fields: { name: 'a'.repeat(80), members: 'a' } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })
})

describe('splitMembers / liveMemberNames', () => {
  it('splits and de-duplicates members', () => {
    expect(splitMembers('a\nb, a')).toEqual(['a', 'b'])
  })
  it('normalizes live member arrays of strings or objects', () => {
    expect(liveMemberNames(['a', { name: 'b' }])).toEqual(['a', 'b'])
  })
})

describe('extractAddressGroup6Specs', () => {
  it('parses members', () => {
    const specs = extractAddressGroup6Specs({
      items: [{ id: 'i1', name: 'G6', fields: { name: 'G6', members: 'a\nb' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].members).toEqual(['a', 'b'])
  })
})
