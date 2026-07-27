import validate, { extractServiceDeskSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('service-desk-integrations validate', () => {
  it('accepts a valid integration', () => {
    const r = validate(ctxWith([{ name: 'SNOW', fields: { name: 'SNOW', type: 'ServiceNowSDIM', attributes: '{"host":"h"}' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and type', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].type')).toBe(true)
  })

  it('rejects invalid attributes JSON', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', type: 'T', attributes: '{bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_attributes')).toBe(true)
  })

  it('warns when attributes are empty', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', type: 'T' } }]))
    expect(r.warnings.some((w) => w.code === 'empty_attributes')).toBe(true)
  })
})

describe('extractServiceDeskSpecs', () => {
  it('stringifies an object attributes blob', () => {
    const specs = extractServiceDeskSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', type: 'T', attributes: { host: 'h' } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].attributesRaw).toBe('{"host":"h"}')
  })
})
