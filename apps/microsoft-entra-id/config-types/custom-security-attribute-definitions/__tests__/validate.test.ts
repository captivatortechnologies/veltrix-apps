import validate, { definitionId, extractAttributeDefinitionSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('custom-security-attribute-definitions validate', () => {
  it('accepts a valid definition', () => {
    const r = validate(
      ctxWith([{ fields: { attributeSet: 'Engineering', name: 'ProjectCode', type: 'String', status: 'Available' } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires attributeSet and name', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ fields: { attributeSet: 'S', name: 'A', type: 'Float' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects a duplicate set+name', () => {
    const r = validate(
      ctxWith([
        { fields: { attributeSet: 'S', name: 'A' } },
        { fields: { attributeSet: 'S', name: 'A' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_definition')).toBe(true)
  })

  it('builds the composite id', () => {
    expect(definitionId({ attributeSet: 'Engineering', name: 'ProjectCode' })).toBe('Engineering_ProjectCode')
  })

  it('defaults type and status', () => {
    const specs = extractAttributeDefinitionSpecs({ items: [{ fields: { attributeSet: 'S', name: 'A' } }] } as never)
    expect(specs[0].type).toBe('String')
    expect(specs[0].status).toBe('Available')
  })
})
