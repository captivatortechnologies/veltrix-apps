import validate, { extractManagedClusterSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('managed-clusters validate', () => {
  it('accepts a valid cluster', () => {
    const r = validate(ctxWith([{ name: 'VA1', fields: { name: 'VA1', type: 'sailpoint' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid configuration JSON', () => {
    const r = validate(ctxWith([{ name: 'VA', fields: { name: 'VA', configuration: '{bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_configuration')).toBe(true)
  })
})

describe('extractManagedClusterSpecs', () => {
  it('defaults type to sailpoint', () => {
    const specs = extractManagedClusterSpecs({
      items: [{ id: 'i1', name: 'VA', fields: { name: 'VA' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('sailpoint')
  })
})
