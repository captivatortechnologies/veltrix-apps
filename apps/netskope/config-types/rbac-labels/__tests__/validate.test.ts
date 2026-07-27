import validate, { extractLabelSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('rbac-labels validate', () => {
  it('accepts a valid label', () => {
    const r = validate(ctxWith([{ name: 'Prod', fields: { name: 'Prod', color: '#4F6DF5' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a label without a color', () => {
    const r = validate(ctxWith([{ name: 'Plain', fields: { name: 'Plain' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { color: '#000000' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid color', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', color: 'red' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractLabelSpecs', () => {
  it('reads name and color, trimming', () => {
    const specs = extractLabelSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' Real ', color: ' #abcdef ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'Real', color: '#abcdef' })
  })
})
