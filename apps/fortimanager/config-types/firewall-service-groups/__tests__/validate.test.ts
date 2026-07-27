import validate, { splitMembers, liveMemberNames, extractServiceGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-service-groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'Web', fields: { name: 'Web', members: 'HTTP\nHTTPS' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { members: 'HTTPS' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one member', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G' } }]))
    expect(r.errors.some((e) => e.code === 'missing_members')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', members: 'HTTP' } },
        { name: 'Dup', fields: { name: 'Dup', members: 'HTTPS' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitMembers / liveMemberNames', () => {
  it('splits and de-duplicates members', () => {
    expect(splitMembers('HTTP\nHTTPS, HTTP')).toEqual(['HTTP', 'HTTPS'])
  })
  it('normalizes live member arrays of strings or objects', () => {
    expect(liveMemberNames(['HTTP', { name: 'HTTPS' }])).toEqual(['HTTP', 'HTTPS'])
  })
})

describe('extractServiceGroupSpecs', () => {
  it('parses members', () => {
    const specs = extractServiceGroupSpecs({
      items: [{ id: 'i1', name: 'G', fields: { name: 'G', members: 'HTTP\nHTTPS' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].members).toEqual(['HTTP', 'HTTPS'])
  })
})
