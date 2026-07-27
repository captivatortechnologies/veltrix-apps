import validate, { extractTenantSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('tenants validate', () => {
  it('accepts a valid tenant', () => {
    const r = validate(ctxWith([{ name: 'Acme', fields: { name: 'Acme', description: 'Acme Corp', eventRateLimit: 5000 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { description: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate tenant name', () => {
    const r = validate(ctxWith([
      { name: 'Acme', fields: { name: 'Acme' } },
      { name: 'acme', fields: { name: 'acme' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a negative rate limit', () => {
    const r = validate(ctxWith([{ name: 'Acme', fields: { name: 'Acme', flowRateLimit: -1 } }]))
    expect(r.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })
})

describe('extractTenantSpecs', () => {
  it('reads name and rate limits from fields', () => {
    const specs = extractTenantSpecs({
      items: [{ id: 'i1', name: 'Acme', fields: { name: 'Acme', eventRateLimit: 1000, flowRateLimit: 200 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Acme')
    expect(specs[0].eventRateLimit).toBe(1000)
    expect(specs[0].flowRateLimit).toBe(200)
  })
})
