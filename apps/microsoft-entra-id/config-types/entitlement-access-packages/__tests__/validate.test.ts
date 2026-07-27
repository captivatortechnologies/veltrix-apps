import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('entitlement-access-packages validate', () => {
  it('accepts a valid package', () => {
    const r = validate(ctxWith([{ fields: { name: 'Sales reps', catalogName: 'Sales' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and catalog name', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'required').length).toBe(2)
  })

  it('rejects a duplicate name within the same catalog', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Dup', catalogName: 'Sales' } },
        { fields: { name: 'Dup', catalogName: 'Sales' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows the same name in different catalogs', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Same', catalogName: 'Sales' } },
        { fields: { name: 'Same', catalogName: 'Eng' } },
      ]),
    )
    expect(r.valid).toBe(true)
  })
})
