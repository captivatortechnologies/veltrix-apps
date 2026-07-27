import validate, { extractDimensionSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('dimensions validate', () => {
  it('accepts a valid dimension', () => {
    const r = validate(ctxWith([{ name: 'East', fields: { roleName: 'Sales', name: 'East', ownerId: 'o' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires role, name and owner', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].roleName')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].ownerId')).toBe(true)
  })

  it('rejects duplicate dimension names within a role', () => {
    const r = validate(
      ctxWith([
        { name: 'East', fields: { roleName: 'Sales', name: 'East', ownerId: 'o' } },
        { name: 'East', fields: { roleName: 'Sales', name: 'East', ownerId: 'o' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractDimensionSpecs', () => {
  it('defaults owner type and stringifies membership', () => {
    const specs = extractDimensionSpecs({
      items: [{ id: 'i1', name: 'East', fields: { roleName: 'Sales', name: 'East', ownerId: 'o', membership: { criteria: {} } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].ownerType).toBe('IDENTITY')
    expect(specs[0].membershipRaw).toBe('{"criteria":{}}')
  })
})
