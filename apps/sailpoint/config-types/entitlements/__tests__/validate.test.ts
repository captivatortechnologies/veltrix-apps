import validate, { extractEntitlementSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('entitlements validate', () => {
  it('accepts a valid entitlement overlay', () => {
    const r = validate(ctxWith([{ name: 'PayrollControls', fields: { sourceName: 'Corporate AD', name: 'PayrollControls', ownerId: '2c91own', privileged: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a source name and a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].sourceName')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
  })

  it('rejects a name longer than 128 chars', () => {
    const r = validate(ctxWith([{ name: 'x'.repeat(129), fields: { sourceName: 'AD', name: 'x'.repeat(129) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects duplicate source+name+attribute combinations', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { sourceName: 'AD', name: 'Dup' } },
        { name: 'Dup', fields: { sourceName: 'AD', name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows the same name on a source when disambiguated by attribute', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { sourceName: 'AD', name: 'Dup', attribute: 'memberOf' } },
        { name: 'Dup', fields: { sourceName: 'AD', name: 'Dup', attribute: 'directReports' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(false)
  })

  it('warns when privileged is set without an owner', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { sourceName: 'AD', name: 'A', privileged: true } }]))
    expect(r.warnings.some((w) => w.code === 'privileged_no_owner')).toBe(true)
  })

  it('does not warn when privileged has an owner', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { sourceName: 'AD', name: 'A', privileged: true, ownerId: 'o1' } }]))
    expect(r.warnings.some((w) => w.code === 'privileged_no_owner')).toBe(false)
  })
})

describe('extractEntitlementSpecs', () => {
  it('reads fields and de-dupes segment ids from tags or a string', () => {
    const specs = extractEntitlementSpecs({
      items: [{ id: 'i1', name: 'A', fields: { sourceName: 'AD', name: 'A', description: 'd', ownerId: 'o', requestable: true, privileged: false, segments: ['s1', 's1', 's2'], lockDisplayName: true, lockDescription: false } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({
      itemId: 'i1',
      sourceName: 'AD',
      attribute: '',
      name: 'A',
      description: 'd',
      ownerId: 'o',
      requestable: true,
      privileged: false,
      segments: ['s1', 's2'],
      lockDisplayName: true,
      lockDescription: false,
    })
  })

  it('parses a comma/newline segments string', () => {
    const specs = extractEntitlementSpecs({
      items: [{ id: 'i1', name: 'A', fields: { sourceName: 'AD', name: 'A', segments: 's1, s2\ns3' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].segments).toEqual(['s1', 's2', 's3'])
  })
})
