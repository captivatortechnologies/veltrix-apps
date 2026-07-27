import validate, { splitIds, extractRoleSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('roles validate', () => {
  it('accepts a valid role', () => {
    const r = validate(ctxWith([{ name: 'Auditors', fields: { name: 'Auditors', roleType: 'Account Group Read Only', accountGroupIds: 'ag-1\nag-2' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { roleType: 'System Admin' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires a role type', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.roleType'))).toBe(true)
  })

  it('accepts a custom permission group name as role type', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', roleType: 'My Custom Permission Group' } }]))
    expect(r.valid).toBe(true)
  })

  it('warns when an account-scoped role type has no account groups', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', roleType: 'Account Group Admin' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_account_groups')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', roleType: 'System Admin' } },
        { name: 'Dup', fields: { name: 'Dup', roleType: 'System Admin' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitIds', () => {
  it('splits, trims and de-duplicates', () => {
    expect(splitIds('a\nb, a')).toEqual(['a', 'b'])
    expect(splitIds(['x', ' x ', 'y'])).toEqual(['x', 'y'])
    expect(splitIds('')).toEqual([])
  })
})

describe('extractRoleSpecs', () => {
  it('parses ids and the boolean flag', () => {
    const specs = extractRoleSpecs({
      items: [{ id: 'i1', name: 'R', fields: { name: 'R', roleType: 'System Admin', accountGroupIds: 'ag-1\nag-2', restrictDismissalAccess: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].accountGroupIds).toEqual(['ag-1', 'ag-2'])
    expect(specs[0].restrictDismissalAccess).toBe(true)
  })
})
