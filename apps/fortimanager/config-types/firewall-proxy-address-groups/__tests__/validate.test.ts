import validate, { splitMembers, liveMemberNames, extractProxyAddressGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-proxy-address-groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'SrcGrp', fields: { name: 'SrcGrp', type: 'src', members: 'ChromeUsers\nApiClients' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'src', members: 'a' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', type: 'both', members: 'a' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires at least one member', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', type: 'src' } }]))
    expect(r.errors.some((e) => e.code === 'missing_members')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'src', members: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'src', members: 'b' } },
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

describe('extractProxyAddressGroupSpecs', () => {
  it('lowercases the type and parses members', () => {
    const specs = extractProxyAddressGroupSpecs({
      items: [{ id: 'i1', name: 'G', fields: { name: 'G', type: 'DST', members: 'a\nb' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('dst')
    expect(specs[0].members).toEqual(['a', 'b'])
  })
})
