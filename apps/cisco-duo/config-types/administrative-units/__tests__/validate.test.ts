import validate, { extractAdminUnitSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('administrative-units validate', () => {
  it('accepts a valid administrative unit', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { name: 'Net Admins', description: 'VPN admins' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { description: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { name: 'Net Admins' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.description'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { name: 'Dup', description: 'x' } },
        { name: 'b', fields: { name: 'dup', description: 'y' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('enforces the name length limit', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { name: 'x'.repeat(256), description: 'd' } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('warns when restrict_by_groups is on', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { name: 'U', description: 'd', restrict_by_groups: true } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'unmanaged_membership')).toBe(true)
  })
})

describe('extractAdminUnitSpecs', () => {
  it('reads scalar fields, trimming, and coerces the checkbox flags', () => {
    const specs = extractAdminUnitSpecs({
      items: [{ id: 'i1', name: 'Fallback', fields: { name: '  Real  ', description: ' d ', restrict_by_groups: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({
      itemId: 'i1',
      name: 'Real',
      description: 'd',
      restrictByGroups: true,
      restrictByIntegrations: false,
    })
  })
})
