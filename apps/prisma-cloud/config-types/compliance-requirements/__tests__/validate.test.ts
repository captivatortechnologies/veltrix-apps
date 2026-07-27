import validate, { extractRequirementSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('compliance-requirements validate', () => {
  it('accepts a valid requirement', () => {
    const r = validate(ctxWith([{ name: 'r', fields: { standardName: 'Internal Baseline', requirementId: '1.1', name: 'Access control', description: 'x', viewOrder: 1 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a parent standard name', () => {
    const r = validate(ctxWith([{ name: 'r', fields: { requirementId: '1.1', name: 'X' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.standardName'))).toBe(true)
  })

  it('requires a requirement id', () => {
    const r = validate(ctxWith([{ name: 'r', fields: { standardName: 'Std', name: 'X' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.requirementId'))).toBe(true)
  })

  it('rejects a negative view order', () => {
    const r = validate(ctxWith([{ name: 'r', fields: { standardName: 'Std', requirementId: '1.1', name: 'X', viewOrder: -3 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_view_order')).toBe(true)
  })

  it('rejects a duplicate requirement within the same standard', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { standardName: 'Std', requirementId: '1.1', name: 'A' } },
        { name: 'b', fields: { standardName: 'std', requirementId: '1.1', name: 'B' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_requirement')).toBe(true)
  })

  it('allows the same requirementId in different standards', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { standardName: 'StdA', requirementId: '1.1', name: 'A' } },
        { name: 'b', fields: { standardName: 'StdB', requirementId: '1.1', name: 'B' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_requirement')).toBe(false)
  })
})

describe('extractRequirementSpecs', () => {
  it('reads fields, trimming and coercing viewOrder', () => {
    const specs = extractRequirementSpecs({
      items: [{ id: 'i1', name: 'Fallback', fields: { standardName: ' Std ', requirementId: ' 1.1 ', name: ' N ', description: ' d ', viewOrder: '4' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', standardName: 'Std', requirementId: '1.1', name: 'N', description: 'd', viewOrder: 4 })
  })
})
