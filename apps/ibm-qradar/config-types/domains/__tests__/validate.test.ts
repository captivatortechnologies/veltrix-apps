import validate, { extractDomainSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('domains validate', () => {
  it('accepts a valid domain', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', description: 'Corporate network' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { description: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate domain name', () => {
    const r = validate(ctxWith([
      { name: 'Corp', fields: { name: 'Corp', description: 'a' } },
      { name: 'corp', fields: { name: 'corp', description: 'b' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('warns on a domain without a description', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_description')).toBe(true)
  })
})

describe('extractDomainSpecs', () => {
  it('reads name and description from fields', () => {
    const specs = extractDomainSpecs({
      items: [{ id: 'i1', name: 'Corp', fields: { name: 'Corp', description: 'Corporate' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Corp')
    expect(specs[0].description).toBe('Corporate')
  })
})
