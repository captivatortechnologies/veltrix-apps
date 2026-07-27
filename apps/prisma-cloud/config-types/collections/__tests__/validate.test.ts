import validate, { splitIds, extractCollectionSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('collections validate', () => {
  it('accepts a valid collection', () => {
    const r = validate(ctxWith([{ name: 'Prod', fields: { name: 'Prod', accountGroupIds: 'ag-1\nag-2' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { accountIds: 'a-1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires at least one asset grouping', () => {
    const r = validate(ctxWith([{ name: 'Empty', fields: { name: 'Empty' } }]))
    expect(r.errors.some((e) => e.code === 'empty_asset_groups')).toBe(true)
  })

  it('accepts a wildcard account id', () => {
    const r = validate(ctxWith([{ name: 'All', fields: { name: 'All', accountIds: '*' } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', accountGroupIds: 'ag-1' } },
        { name: 'Dup', fields: { name: 'Dup', accountGroupIds: 'ag-1' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitIds', () => {
  it('splits, trims and de-duplicates', () => {
    expect(splitIds('a\nb, a')).toEqual(['a', 'b'])
    expect(splitIds('')).toEqual([])
  })
})

describe('extractCollectionSpecs', () => {
  it('parses the three id lists', () => {
    const specs = extractCollectionSpecs({
      items: [{ id: 'i1', name: 'C', fields: { name: 'C', accountGroupIds: 'ag-1', accountIds: 'a-1\na-2', repositoryIds: '*' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].assetGroups.accountIds).toEqual(['a-1', 'a-2'])
    expect(specs[0].assetGroups.repositoryIds).toEqual(['*'])
  })
})
