import validate, { extractNonEmployeeSourceSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('non-employee-sources validate', () => {
  it('accepts a valid source', () => {
    const r = validate(ctxWith([{ name: 'Contractors', fields: { name: 'Contractors', description: 'd', ownerId: 'o' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, description and owner', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].description')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].ownerId')).toBe(true)
  })

  it('rejects too many approvers', () => {
    const r = validate(ctxWith([{ name: 'C', fields: { name: 'C', description: 'd', ownerId: 'o', approvers: ['a', 'b', 'c', 'd'] } }]))
    expect(r.errors.some((e) => e.code === 'too_many')).toBe(true)
  })
})

describe('extractNonEmployeeSourceSpecs', () => {
  it('de-dupes approver/manager ids', () => {
    const specs = extractNonEmployeeSourceSpecs({
      items: [{ id: 'i1', name: 'C', fields: { name: 'C', description: 'd', ownerId: 'o', approvers: ['a', 'a'], accountManagers: ['m'] } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].approvers).toEqual(['a'])
    expect(specs[0].accountManagers).toEqual(['m'])
  })
})
