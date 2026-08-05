import validate, { extractTaggedFieldSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('tagged-fields validate', () => {
  it('accepts a valid tagged field', () => {
    const r = validate(ctxWith([{
      name: 'customField1',
      fields: { name: 'customField1', type: 'Integer', privateEnterpriseNumber: 9, elementId: 100, categoryName: 'PII', isArray: false },
    }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { categoryName: 'PII' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires a category', () => {
    const r = validate(ctxWith([{ name: 'F', fields: { name: 'F' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.categoryName'))).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'F', fields: { name: 'F', categoryName: 'PII' } },
      { name: 'f', fields: { name: 'f', categoryName: 'PII' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an invalid field type', () => {
    const r = validate(ctxWith([{ name: 'F', fields: { name: 'F', type: 'Nonsense', categoryName: 'PII' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_field_type')).toBe(true)
  })

  it('rejects a negative private enterprise number', () => {
    const r = validate(ctxWith([{ name: 'F', fields: { name: 'F', categoryName: 'PII', privateEnterpriseNumber: -1 } }]))
    expect(r.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })
})

describe('extractTaggedFieldSpecs', () => {
  it('reads all fields, defaulting type to String and isArray to false', () => {
    const specs = extractTaggedFieldSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: 'F', categoryName: 'PII', elementId: 12, privateEnterpriseNumber: 9 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('String')
    expect(specs[0].isArray).toBe(false)
    expect(specs[0].elementId).toBe(12)
    expect(specs[0].privateEnterpriseNumber).toBe(9)
  })
})
