import validate, { isBuiltInCatalog } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('entitlement-access-package-catalogs validate', () => {
  it('accepts a valid catalog', () => {
    const r = validate(ctxWith([{ fields: { name: 'Engineering', state: 'published' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ fields: { state: 'published' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid state', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', state: 'draft' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_state')).toBe(true)
  })

  it('warns for the reserved General catalog', () => {
    const r = validate(ctxWith([{ fields: { name: 'General', state: 'published' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'reserved_catalog')).toBe(true)
  })

  it('detects a built-in service-default catalog', () => {
    expect(isBuiltInCatalog({ catalogType: 'serviceDefault' })).toBe(true)
    expect(isBuiltInCatalog({ catalogType: 'userManaged' })).toBe(false)
  })
})
