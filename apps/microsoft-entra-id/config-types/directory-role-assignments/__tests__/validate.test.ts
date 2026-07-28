import validate, { assignmentKey, isGuid } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const ROLE = '62e90394-69f5-4237-9190-012177145e10'
const PRINCIPAL = 'f8ca5a85-489a-49a0-b555-0a6d81e56f0d'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('directory-role-assignments validate', () => {
  it('accepts a valid tenant-wide assignment', () => {
    const r = validate(ctxWith([{ fields: { roleDefinitionId: ROLE, principalId: PRINCIPAL, directoryScopeId: '/' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('defaults directoryScopeId to "/" when omitted', () => {
    const r = validate(ctxWith([{ fields: { roleDefinitionId: ROLE, principalId: PRINCIPAL } }]))
    expect(r.valid).toBe(true)
  })

  it('requires roleDefinitionId and principalId', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'required').length).toBe(2)
  })

  it('rejects a non-GUID role definition id', () => {
    const r = validate(ctxWith([{ fields: { roleDefinitionId: 'not-a-guid', principalId: PRINCIPAL } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_guid')).toBe(true)
  })

  it('rejects a directory scope that does not start with "/"', () => {
    const r = validate(
      ctxWith([{ fields: { roleDefinitionId: ROLE, principalId: PRINCIPAL, directoryScopeId: 'administrativeUnits/x' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_scope')).toBe(true)
  })

  it('rejects duplicate tuples', () => {
    const r = validate(
      ctxWith([
        { fields: { roleDefinitionId: ROLE, principalId: PRINCIPAL, directoryScopeId: '/' } },
        { fields: { roleDefinitionId: ROLE, principalId: PRINCIPAL, directoryScopeId: '/' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_assignment')).toBe(true)
  })
})

describe('helpers', () => {
  it('builds a stable, case-insensitive tuple key', () => {
    expect(assignmentKey({ roleDefinitionId: 'ROLE', principalId: 'PRIN', directoryScopeId: '/' })).toBe('role|prin|/')
  })

  it('treats an empty scope as tenant-wide "/"', () => {
    expect(assignmentKey({ roleDefinitionId: 'r', principalId: 'p', directoryScopeId: '' })).toBe('r|p|/')
  })

  it('validates GUID shape', () => {
    expect(isGuid(ROLE)).toBe(true)
    expect(isGuid('nope')).toBe(false)
  })
})
