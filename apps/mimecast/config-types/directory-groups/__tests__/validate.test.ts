import validate, { extractDirectoryGroupSpecs, groupKey, memberIdentity, liveMemberIdentity } from '../validate'
import { extractGroups, extractMembers } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('directory-groups validate', () => {
  it('accepts a valid group with email and domain members', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { description: 'Partners', members: ['user@example.com', 'partner.example'] } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { members: [] } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid member', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { description: 'G', members: ['not a member'] } }]))
    expect(r.errors.some((e) => e.code === 'invalid_member')).toBe(true)
  })

  it('rejects a duplicate member', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { description: 'G', members: ['a@b.com', 'A@B.com'] } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_member')).toBe(true)
  })

  it('rejects duplicate group names under the same parent', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { description: 'Dup', parentId: 'P1' } },
        { name: 'B', fields: { description: 'Dup', parentId: 'P1' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_description')).toBe(true)
  })
})

describe('identity + extractors', () => {
  it('classifies members and mirrors live identities', () => {
    expect(memberIdentity('User@Example.com')).toBe('email:user@example.com')
    expect(memberIdentity('Example.COM')).toBe('domain:example.com')
    expect(liveMemberIdentity({ emailAddress: 'User@Example.com' })).toBe('email:user@example.com')
    expect(liveMemberIdentity({ domain: 'Example.com' })).toBe('domain:example.com')
  })

  it('keys root groups by name and scoped groups by name+parent', () => {
    const specs = extractDirectoryGroupSpecs(
      ctxWith([
        { name: 'A', fields: { description: 'Root' } },
        { name: 'B', fields: { description: 'Child', parentId: 'P1' } },
      ]).canvas
    )
    expect(groupKey(specs[0])).toBe('root')
    expect(groupKey(specs[1])).toBe('child|P1')
  })

  it('flattens nested groups and both member response shapes', () => {
    const groups = extractGroups([
      { query: '', source: 'cloud', folders: [{ id: 'G1', description: 'Top', folders: [{ id: 'G2', description: 'Nested' }] }] },
    ])
    expect(groups.map((g) => g.id)).toEqual(['G1', 'G2'])
    expect(extractMembers([{ groupMembers: [{ emailAddress: 'a@b.com' }] }])).toHaveLength(1)
    expect(extractMembers([{ emailAddress: 'a@b.com' }, { domain: 'c.com' }])).toHaveLength(2)
  })
})
