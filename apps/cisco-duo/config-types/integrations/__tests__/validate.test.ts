import validate, { extractIntegrationSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('integrations validate', () => {
  it('accepts a valid integration', () => {
    const r = validate(ctxWith([{ name: 'Web App', fields: { name: 'Web App', type: 'websdk' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'websdk' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a type', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'websdk' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'authapi' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractIntegrationSpecs', () => {
  it('reads name and type, trimming', () => {
    const specs = extractIntegrationSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' Real ', type: ' websdk ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'Real', type: 'websdk' })
  })
})
