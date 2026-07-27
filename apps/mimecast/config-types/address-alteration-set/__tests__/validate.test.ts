import validate, { extractAddressAlterationSetSpecs, setKey } from '../validate'
import { extractSets, type RollbackEntry } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('address-alteration-set validate', () => {
  it('accepts a valid set', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { description: 'Partners' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate descriptions under the same parent', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { description: 'Dup', parentId: 'P1' } },
        { name: 'B', fields: { description: 'Dup', parentId: 'P1' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_description')).toBe(true)
  })

  it('allows the same description under different parents', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { description: 'Same', parentId: 'P1' } },
        { name: 'B', fields: { description: 'Same', parentId: 'P2' } },
      ])
    )
    expect(r.valid).toBe(true)
  })
})

describe('setKey / extractSets', () => {
  it('keys root sets by name only and scoped sets by name+parent', () => {
    const specs = extractAddressAlterationSetSpecs(
      ctxWith([
        { name: 'A', fields: { description: 'Root' } },
        { name: 'B', fields: { description: 'Child', parentId: 'P1' } },
      ]).canvas
    )
    expect(setKey(specs[0])).toBe('root')
    expect(setKey(specs[1])).toBe('child|P1')
  })

  it('flattens nested folders from a get-set response', () => {
    const sets = extractSets([
      { id: 'S1', description: 'Top', folders: [{ id: 'S2', description: 'Nested' }] },
      { id: 'S3', description: 'Other' },
    ])
    expect(sets).toHaveLength(3)
    expect(sets.map((s) => s.id)).toEqual(['S1', 'S2', 'S3'])
  })

  it('carries the existed flag on a rollback entry shape', () => {
    const entry: RollbackEntry = { name: 'Partners', parentId: '', existed: false, id: 'S9' }
    expect(entry.existed).toBe(false)
    expect(entry.id).toBe('S9')
  })
})
