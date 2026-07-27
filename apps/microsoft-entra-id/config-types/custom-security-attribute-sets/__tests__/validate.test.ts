import validate, { asNumberOrNull, extractAttributeSetSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('custom-security-attribute-sets validate', () => {
  it('accepts a valid set', () => {
    const r = validate(ctxWith([{ fields: { id: 'Engineering', description: 'Eng attributes' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an id', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an id with spaces', () => {
    const r = validate(ctxWith([{ fields: { id: 'my set' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_id')).toBe(true)
  })

  it('rejects a non-positive max', () => {
    const r = validate(ctxWith([{ fields: { id: 'Eng', maxAttributesPerSet: 0 } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_max')).toBe(true)
  })

  it('rejects duplicate ids', () => {
    const r = validate(ctxWith([{ fields: { id: 'Dup' } }, { fields: { id: 'Dup' } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_id')).toBe(true)
  })
})

describe('helpers', () => {
  it('coerces blank max to null', () => {
    const specs = extractAttributeSetSpecs({ items: [{ fields: { id: 'X' } }] } as never)
    expect(specs[0].maxAttributesPerSet).toBe(null)
  })

  it('parses numeric strings', () => {
    expect(asNumberOrNull('10')).toBe(10)
    expect(asNumberOrNull('')).toBe(null)
  })
})
