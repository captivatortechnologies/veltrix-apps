import validate, { extractTaggedFieldCategorySpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('tagged-field-categories validate', () => {
  it('accepts a valid category', () => {
    const r = validate(ctxWith([{ name: 'PII', fields: { name: 'PII' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'PII', fields: { name: 'PII' } },
      { name: 'pii', fields: { name: 'pii' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a name over 255 characters', () => {
    const r = validate(ctxWith([{ name: 'x'.repeat(256), fields: { name: 'x'.repeat(256) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })
})

describe('extractTaggedFieldCategorySpecs', () => {
  it('reads name from fields', () => {
    const specs = extractTaggedFieldCategorySpecs({
      items: [{ id: 'i1', name: 'PII', fields: { name: 'PII' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('PII')
  })
})
