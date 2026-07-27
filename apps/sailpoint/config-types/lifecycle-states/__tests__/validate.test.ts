import validate, { extractLifecycleStateSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('lifecycle-states validate', () => {
  it('accepts a valid lifecycle state', () => {
    const r = validate(ctxWith([{ name: 'Active', fields: { profileName: 'Employees', name: 'Active', technicalName: 'active' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires profile, name and technical name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].profileName')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].technicalName')).toBe(true)
  })

  it('rejects invalid account actions JSON', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { profileName: 'P', name: 'A', technicalName: 'active', accountActions: '{bad}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_actions')).toBe(true)
  })

  it('rejects duplicate technical names within the same profile', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { profileName: 'P', name: 'A', technicalName: 'active' } },
        { name: 'B', fields: { profileName: 'P', name: 'B', technicalName: 'active' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractLifecycleStateSpecs', () => {
  it('stringifies an array accountActions field', () => {
    const specs = extractLifecycleStateSpecs({
      items: [{ id: 'i1', name: 'A', fields: { profileName: 'P', name: 'A', technicalName: 'active', accountActions: [{ action: 'DISABLE' }] } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].accountActionsRaw).toBe('[{"action":"DISABLE"}]')
  })
})
