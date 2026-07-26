import validate, { extractTagSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('device-classification-tags validate', () => {
  it('accepts a valid tag', () => {
    const r = validate(ctxWith([{ name: 'Managed', fields: { name: 'Managed', description: 'Corp EDR' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { description: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 80 chars', () => {
    const long = 'x'.repeat(81)
    const r = validate(ctxWith([{ name: long, fields: { name: long } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
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

describe('extractTagSpecs', () => {
  it('reads name and description, trimming', () => {
    const specs = extractTagSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' Real ', description: ' d ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'Real', description: 'd' })
  })
})
