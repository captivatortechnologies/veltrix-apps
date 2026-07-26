import validate, { extractSegmentSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('segments validate', () => {
  it('accepts a valid segment', () => {
    const r = validate(ctxWith([{ name: 'Contractors', fields: { name: 'Contractors', description: 'x', active: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { description: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
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

describe('extractSegmentSpecs', () => {
  it('coerces the active flag', () => {
    const specs = extractSegmentSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', active: 'true' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].active).toBe(true)
  })
})
