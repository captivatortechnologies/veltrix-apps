import validate, { splitMembers, liveMemberNames, extractInternetServiceCustomGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-internet-service-custom-groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'Grp', fields: { name: 'Grp', members: 'SvcA\nSvcB' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { members: 'SvcA' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one member', () => {
    const r = validate(ctxWith([{ name: 'Grp', fields: { name: 'Grp', members: '' } }]))
    expect(r.errors.some((e) => e.code === 'missing_members')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', members: 'A' } },
        { name: 'Dup', fields: { name: 'Dup', members: 'B' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitMembers', () => {
  it('splits and dedupes by newline or comma', () => {
    expect(splitMembers('A\nB, C, A')).toEqual(['A', 'B', 'C'])
  })
})

describe('liveMemberNames', () => {
  it('normalizes string and object members', () => {
    expect(liveMemberNames(['A', { name: 'B' }])).toEqual(['A', 'B'])
  })
})

describe('extractInternetServiceCustomGroupSpecs', () => {
  it('extracts members from a textarea', () => {
    const specs = extractInternetServiceCustomGroupSpecs({
      items: [{ id: 'i1', name: 'Grp', fields: { name: 'Grp', members: 'SvcA\nSvcB' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].members).toHaveLength(2)
  })
})
