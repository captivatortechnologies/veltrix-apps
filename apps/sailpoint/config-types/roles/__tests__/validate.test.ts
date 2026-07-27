import validate, { extractRoleSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('roles validate', () => {
  it('accepts a valid role', () => {
    const r = validate(ctxWith([{ name: 'Analyst', fields: { name: 'Analyst', ownerId: '2c91own', accessProfileIds: ['ap1'] } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ownerId: 'o' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires an owner id', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].ownerId')).toBe(true)
  })

  it('warns when a role bundles no access profiles', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', ownerId: 'o' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_access_profiles')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', ownerId: 'o', accessProfileIds: ['a'] } },
        { name: 'Dup', fields: { name: 'Dup', ownerId: 'o', accessProfileIds: ['b'] } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractRoleSpecs', () => {
  it('reads fields and de-dupes access profile ids', () => {
    const specs = extractRoleSpecs({
      items: [{ id: 'i1', name: 'R', fields: { name: 'R', description: 'd', ownerId: 'o', accessProfileIds: ['a1', 'a1', 'a2'], enabled: true, requestable: false } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'R', description: 'd', ownerId: 'o', accessProfileIds: ['a1', 'a2'], enabled: true, requestable: false })
  })
})
