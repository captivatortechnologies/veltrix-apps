import validate, { extractCorrelationConfigSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('correlation-configs validate', () => {
  it('accepts a valid config', () => {
    const r = validate(ctxWith([{ name: 'AD Corr', fields: { name: 'AD Corr', attributes: '[{"attributeName":"email"}]' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid attributes JSON', () => {
    const r = validate(ctxWith([{ name: 'C', fields: { name: 'C', attributes: '{not an array}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_attributes')).toBe(true)
  })
})

describe('extractCorrelationConfigSpecs', () => {
  it('stringifies an array attributes field', () => {
    const specs = extractCorrelationConfigSpecs({
      items: [{ id: 'i1', name: 'C', fields: { name: 'C', attributes: [{ a: 1 }] } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].attributesRaw).toBe('[{"a":1}]')
  })
})
