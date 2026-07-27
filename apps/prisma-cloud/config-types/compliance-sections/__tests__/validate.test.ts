import validate, { extractSectionSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('compliance-sections validate', () => {
  it('accepts a valid section', () => {
    const r = validate(ctxWith([{ name: 's', fields: { standardName: 'Internal Baseline', requirementId: '1.1', sectionId: '1.1.1', description: 'x', viewOrder: 1 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a parent standard name', () => {
    const r = validate(ctxWith([{ name: 's', fields: { requirementId: '1.1', sectionId: '1.1.1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.standardName'))).toBe(true)
  })

  it('requires a parent requirement id', () => {
    const r = validate(ctxWith([{ name: 's', fields: { standardName: 'Std', sectionId: '1.1.1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.requirementId'))).toBe(true)
  })

  it('requires a section id', () => {
    const r = validate(ctxWith([{ name: '', fields: { standardName: 'Std', requirementId: '1.1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.sectionId'))).toBe(true)
  })

  it('rejects a negative view order', () => {
    const r = validate(ctxWith([{ name: 's', fields: { standardName: 'Std', requirementId: '1.1', sectionId: '1.1.1', viewOrder: -3 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_view_order')).toBe(true)
  })

  it('rejects a duplicate section within the same requirement', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { standardName: 'Std', requirementId: '1.1', sectionId: '1.1.1' } },
        { name: 'b', fields: { standardName: 'std', requirementId: '1.1', sectionId: '1.1.1' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_section')).toBe(true)
  })

  it('allows the same sectionId in different requirements', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { standardName: 'Std', requirementId: '1.1', sectionId: '1.1.1' } },
        { name: 'b', fields: { standardName: 'Std', requirementId: '1.2', sectionId: '1.1.1' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_section')).toBe(false)
  })
})

describe('extractSectionSpecs', () => {
  it('reads fields, trimming and coercing viewOrder', () => {
    const specs = extractSectionSpecs({
      items: [{ id: 'i1', name: 'Fallback', fields: { standardName: ' Std ', requirementId: ' 1.1 ', sectionId: ' 1.1.1 ', description: ' d ', viewOrder: '4' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', standardName: 'Std', requirementId: '1.1', sectionId: '1.1.1', description: 'd', viewOrder: 4 })
  })
})
