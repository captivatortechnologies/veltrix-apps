import validate, { actionsEqual, isCustomRole, liveActions } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('directory-role-definitions validate', () => {
  it('accepts a valid custom role', () => {
    const r = validate(
      ctxWith([
        { name: 'App Support', fields: { name: 'App Support', allowedResourceActions: 'microsoft.directory/applications/basic/read' } },
      ])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { allowedResourceActions: 'microsoft.directory/applications/basic/read' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one action', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', allowedResourceActions: '' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'missing_actions')).toBe(true)
  })

  it('rejects an action without a resource path', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', allowedResourceActions: 'notanaction' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('warns on a non-microsoft action', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', allowedResourceActions: 'custom.thing/read' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'unexpected_action')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', allowedResourceActions: 'microsoft.directory/x/read' } },
        { name: 'Dup', fields: { name: 'Dup', allowedResourceActions: 'microsoft.directory/x/read' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('role helpers', () => {
  it('flattens live rolePermissions into an action list', () => {
    const actions = liveActions({ rolePermissions: [{ allowedResourceActions: ['a', 'b'] }, { allowedResourceActions: ['c'] }] })
    expect(actions).toEqual(['a', 'b', 'c'])
  })

  it('compares action collections as sets', () => {
    expect(actionsEqual(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(actionsEqual(['a'], ['a', 'b'])).toBe(false)
  })

  it('treats only non-built-in roles as manageable', () => {
    expect(isCustomRole({ isBuiltIn: false })).toBe(true)
    expect(isCustomRole({ isBuiltIn: true })).toBe(false)
  })
})
