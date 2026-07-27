import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('user-flow-attributes validate', () => {
  it('accepts a valid attribute', () => {
    const r = validate(ctxWith([{ fields: { name: 'Department', dataType: 'string' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and data type', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'required').length).toBe(2)
  })

  it('rejects an invalid data type', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', dataType: 'float' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_data_type')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Dup', dataType: 'string' } },
        { fields: { name: 'Dup', dataType: 'boolean' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})
