import validate, { splitIds, extractAccountGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('account-groups validate', () => {
  it('accepts a valid account group', () => {
    const r = validate(ctxWith([{ name: 'Prod', fields: { name: 'Prod', description: 'x', accountIds: 'acc-1\nacc-2' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { accountIds: 'acc-1' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('warns on an empty account group', () => {
    const r = validate(ctxWith([{ name: 'Empty', fields: { name: 'Empty' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_accounts')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', accountIds: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', accountIds: 'b' } },
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

describe('extractAccountGroupSpecs', () => {
  it('parses account ids', () => {
    const specs = extractAccountGroupSpecs({
      items: [{ id: 'i1', name: 'G', fields: { name: 'G', accountIds: 'acc-1\nacc-2' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].accountIds).toEqual(['acc-1', 'acc-2'])
  })
})
