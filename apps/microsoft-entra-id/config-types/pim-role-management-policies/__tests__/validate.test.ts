import validate, { desiredEnabledRules, extractPimPolicySpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const ROLE = '62e90394-69f5-4237-9190-012177145e10'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('pim-role-management-policies validate', () => {
  it('accepts a valid role policy', () => {
    const r = validate(
      ctxWith([{ fields: { roleDefinitionId: ROLE, requireMfaOnActivation: true, activationExpirationRequired: true, activationMaximumDuration: 'PT8H' } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a role definition id', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a non-GUID role id', () => {
    const r = validate(ctxWith([{ fields: { roleDefinitionId: 'Global Administrator' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_role_id')).toBe(true)
  })

  it('requires a duration when expiration is required', () => {
    const r = validate(ctxWith([{ fields: { roleDefinitionId: ROLE, activationExpirationRequired: true, activationMaximumDuration: '' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'duration_required')).toBe(true)
  })

  it('rejects a malformed duration', () => {
    const r = validate(ctxWith([{ fields: { roleDefinitionId: ROLE, activationMaximumDuration: '8 hours' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('rejects duplicate roles', () => {
    const r = validate(ctxWith([{ fields: { roleDefinitionId: ROLE } }, { fields: { roleDefinitionId: ROLE } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_role')).toBe(true)
  })
})

describe('helpers', () => {
  it('builds enabledRules from toggles', () => {
    const specs = extractPimPolicySpecs({
      items: [{ fields: { roleDefinitionId: ROLE, requireMfaOnActivation: true, requireTicketingOnActivation: true } }],
    } as never)
    expect(desiredEnabledRules(specs[0])).toEqual(['MultiFactorAuthentication', 'Ticketing'])
  })
})
