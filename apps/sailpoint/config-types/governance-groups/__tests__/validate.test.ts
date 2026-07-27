import validate, { extractGovernanceGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('governance-groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'DB Access', fields: { name: 'DB Access', description: 'x', ownerId: '2c91abc' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ownerId: '2c91abc' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires an owner id', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', ownerId: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', ownerId: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractGovernanceGroupSpecs', () => {
  it('reads name, description and ownerId', () => {
    const specs = extractGovernanceGroupSpecs({
      items: [{ id: 'i1', name: 'G', fields: { name: 'G', description: 'd', ownerId: '2c91' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'G', description: 'd', ownerId: '2c91' })
  })
})
