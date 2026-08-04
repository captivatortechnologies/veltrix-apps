import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('entitlement-access-packages validate', () => {
  it('accepts a valid package', () => {
    const r = validate(ctxWith([{ fields: { name: 'Sales reps', catalogId: 'Sales' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and catalog', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'required').length).toBe(2)
  })

  it('accepts a picker-stored catalog GUID', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'Sales reps', catalogId: '66584aae-98bb-48cc-9458-7bee5d2a6577' } }]),
    )
    expect(r.valid).toBe(true)
  })

  it('rejects a duplicate name within the same catalog', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Dup', catalogId: 'Sales' } },
        { fields: { name: 'Dup', catalogId: 'Sales' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows the same name in different catalogs', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Same', catalogId: 'Sales' } },
        { fields: { name: 'Same', catalogId: 'Eng' } },
      ]),
    )
    expect(r.valid).toBe(true)
  })
})
