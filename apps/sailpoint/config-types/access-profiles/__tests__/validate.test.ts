import validate, { extractAccessProfileSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('access-profiles validate', () => {
  it('accepts a valid access profile', () => {
    const r = validate(ctxWith([{ name: 'DB RW', fields: { name: 'DB RW', ownerId: '2c91own', sourceId: '2c91src', entitlementIds: ['e1', 'e2'], enabled: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ownerId: 'o', sourceId: 's' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires an owner id and a source id', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].ownerId')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].sourceId')).toBe(true)
  })

  it('rejects an enabled profile with no entitlements', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', ownerId: 'o', sourceId: 's', enabled: true } }]))
    expect(r.errors.some((e) => e.code === 'entitlements_required')).toBe(true)
  })

  it('allows a disabled profile with no entitlements', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', ownerId: 'o', sourceId: 's', enabled: false } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', ownerId: 'o', sourceId: 's' } },
        { name: 'Dup', fields: { name: 'Dup', ownerId: 'o', sourceId: 's' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractAccessProfileSpecs', () => {
  it('reads fields and de-dupes entitlement ids from tags or a string', () => {
    const specs = extractAccessProfileSpecs({
      items: [{ id: 'i1', name: 'A', fields: { name: 'A', description: 'd', ownerId: 'o', sourceId: 's', entitlementIds: ['e1', 'e1', 'e2'], enabled: true, requestable: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'A', description: 'd', ownerId: 'o', sourceId: 's', entitlementIds: ['e1', 'e2'], enabled: true, requestable: true })
  })

  it('parses a comma/newline entitlement string', () => {
    const specs = extractAccessProfileSpecs({
      items: [{ id: 'i1', name: 'A', fields: { name: 'A', entitlementIds: 'e1, e2\ne3' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].entitlementIds).toEqual(['e1', 'e2', 'e3'])
  })
})
