import validate, { splitMembers, liveMemberNames, extractVipGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-vip-groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'WebVips', fields: { name: 'WebVips', members: 'WebVip\nApiVip' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { members: 'a' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one member', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G' } }]))
    expect(r.errors.some((e) => e.code === 'missing_members')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', members: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', members: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
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

describe('extractVipGroupSpecs', () => {
  it('parses members and interface', () => {
    const specs = extractVipGroupSpecs({
      items: [{ id: 'i1', name: 'G', fields: { name: 'G', members: 'a\nb', interface: 'port1' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].members).toEqual(['a', 'b'])
    expect(specs[0].interface).toBe('port1')
  })
})
