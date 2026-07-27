import validate, { extractSodPolicySpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('sod-policies validate', () => {
  it('accepts a valid general policy', () => {
    const r = validate(ctxWith([{ name: 'SOD1', fields: { name: 'SOD1', ownerId: 'o', type: 'GENERAL', policyQuery: '@access(source.name:*)' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires criteria for a conflicting-access policy', () => {
    const r = validate(ctxWith([{ name: 'SOD2', fields: { name: 'SOD2', ownerId: 'o', type: 'CONFLICTING_ACCESS_BASED' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].criteria')).toBe(true)
  })

  it('requires an owner id', () => {
    const r = validate(ctxWith([{ name: 'SOD', fields: { name: 'SOD' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].ownerId')).toBe(true)
  })

  it('rejects an invalid state', () => {
    const r = validate(ctxWith([{ name: 'SOD', fields: { name: 'SOD', ownerId: 'o', state: 'NOPE' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })
})

describe('extractSodPolicySpecs', () => {
  it('defaults type/state/ownerType', () => {
    const specs = extractSodPolicySpecs({
      items: [{ id: 'i1', name: 'SOD', fields: { name: 'SOD', ownerId: 'o' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('GENERAL')
    expect(specs[0].state).toBe('NOT_ENFORCED')
    expect(specs[0].ownerType).toBe('IDENTITY')
  })
})
