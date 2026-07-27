import validate, { extractSimIntegrationSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('sim-integrations validate', () => {
  it('accepts a valid integration', () => {
    const r = validate(ctxWith([{ name: 'SNOW', fields: { name: 'SNOW', type: 'ServiceNow Service Desk', cluster: 'c1', attributes: '{"host":"h"}' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, type and cluster', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].type')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].cluster')).toBe(true)
  })

  it('rejects invalid attributes JSON', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', type: 'T', cluster: 'c', attributes: '{bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_attributes')).toBe(true)
  })
})

describe('extractSimIntegrationSpecs', () => {
  it('de-dupes sources and stringifies attributes', () => {
    const specs = extractSimIntegrationSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', type: 'T', cluster: 'c', sources: ['a', 'a', 'b'], attributes: { h: 1 } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].sources).toEqual(['a', 'b'])
    expect(specs[0].attributesRaw).toBe('{"h":1}')
  })
})
