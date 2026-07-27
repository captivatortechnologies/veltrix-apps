import validate, { extractIdentityAttributeSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('identity-attributes validate', () => {
  it('accepts a valid attribute', () => {
    const r = validate(ctxWith([{ name: 'costCenter', fields: { name: 'costCenter', displayName: 'Cost Center', searchable: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid sources JSON', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { name: 'x', sources: '{bad}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_sources')).toBe(true)
  })
})

describe('extractIdentityAttributeSpecs', () => {
  it('defaults type to string and stringifies sources', () => {
    const specs = extractIdentityAttributeSpecs({
      items: [{ id: 'i1', name: 'x', fields: { name: 'x', sources: [{ type: 'rule' }] } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('string')
    expect(specs[0].sourcesRaw).toBe('[{"type":"rule"}]')
  })
})
