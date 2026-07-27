import validate, { extractCustomPropertySpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const expr = '[{"logSourceType":"Linux OS","regex":"bytes=(\\\\d+)","captureGroup":1}]'
const base = { name: 'FlowBytes', propertyType: 'numeric', expressions: expr }

describe('flow-custom-properties validate', () => {
  it('accepts a valid flow custom property', () => {
    const r = validate(ctxWith([{ name: 'FlowBytes', fields: { ...base } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ...base, name: '' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid property type', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, propertyType: 'boolean' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_property_type')).toBe(true)
  })
})

describe('extractCustomPropertySpecs (flow)', () => {
  it('reads name and property type from fields', () => {
    const specs = extractCustomPropertySpecs({
      items: [{ id: 'i1', name: 'FlowBytes', fields: { ...base } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('FlowBytes')
    expect(specs[0].propertyType).toBe('numeric')
  })
})
