import validate, {
  desiredExpiration,
  eligibilityKey,
  expirationDiff,
  extractEligibilitySpecs,
  type LiveEligibilitySchedule,
} from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const PRINCIPAL = '071cc716-8147-4397-a5ba-b2105951cc0b'
const ROLE = '62e90394-69f5-4237-9190-012177145e10'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('pim-role-eligibility validate', () => {
  it('accepts a valid permanent eligibility', () => {
    const r = validate(
      ctxWith([{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, justification: 'privileged access' } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a principal id', () => {
    const r = validate(ctxWith([{ fields: { roleDefinitionId: ROLE, justification: 'x' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.field.endsWith('principalId') && e.code === 'required')).toBe(true)
  })

  it('requires a role definition id', () => {
    const r = validate(ctxWith([{ fields: { principalId: PRINCIPAL, justification: 'x' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.field.endsWith('roleDefinitionId') && e.code === 'required')).toBe(true)
  })

  it('requires a justification', () => {
    const r = validate(ctxWith([{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.field.endsWith('justification') && e.code === 'required')).toBe(true)
  })

  it('accepts a hand-typed principal display name (pre-picker canvases) — resolved at deploy time', () => {
    const r = validate(ctxWith([{ fields: { principalId: 'Alice', roleDefinitionId: ROLE, justification: 'x' } }]))
    expect(r.valid).toBe(true)
  })

  it('accepts a hand-typed role display name (pre-picker canvases) — resolved at deploy time', () => {
    const r = validate(ctxWith([{ fields: { principalId: PRINCIPAL, roleDefinitionId: 'Global Administrator', justification: 'x' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires an end date/time when expiration is afterDateTime', () => {
    const r = validate(
      ctxWith([{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, justification: 'x', expirationType: 'afterDateTime' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'end_required')).toBe(true)
  })

  it('rejects a malformed end date/time', () => {
    const r = validate(
      ctxWith([{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, justification: 'x', expirationType: 'afterDateTime', endDateTime: 'next friday' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_end')).toBe(true)
  })

  it('requires a duration when expiration is afterDuration', () => {
    const r = validate(
      ctxWith([{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, justification: 'x', expirationType: 'afterDuration' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'duration_required')).toBe(true)
  })

  it('rejects a malformed duration', () => {
    const r = validate(
      ctxWith([{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, justification: 'x', expirationType: 'afterDuration', duration: '365 days' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('accepts a valid afterDuration eligibility', () => {
    const r = validate(
      ctxWith([{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, justification: 'x', expirationType: 'afterDuration', duration: 'P365D' } }]),
    )
    expect(r.valid).toBe(true)
  })

  it('rejects a duplicate principal/role/scope tuple', () => {
    const r = validate(
      ctxWith([
        { fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, justification: 'x' } },
        { fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, justification: 'y' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_eligibility')).toBe(true)
  })

  it('allows the same principal+role at different scopes', () => {
    const r = validate(
      ctxWith([
        { fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, directoryScopeId: '/', justification: 'x' } },
        { fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, directoryScopeId: '/administrativeUnits/abc', justification: 'y' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_eligibility')).toBe(false)
  })
})

describe('helpers', () => {
  it('builds a noExpiration expiration by default', () => {
    const specs = extractEligibilitySpecs({ items: [{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE } }] } as never)
    expect(desiredExpiration(specs[0])).toEqual({ type: 'noExpiration' })
  })

  it('builds an afterDateTime expiration', () => {
    const specs = extractEligibilitySpecs({
      items: [{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, expirationType: 'afterDateTime', endDateTime: '2026-12-31T00:00:00Z' } }],
    } as never)
    expect(desiredExpiration(specs[0])).toEqual({ type: 'afterDateTime', endDateTime: '2026-12-31T00:00:00Z' })
  })

  it('defaults an empty scope to "/" in the identity key', () => {
    expect(eligibilityKey(PRINCIPAL, ROLE, '')).toBe(eligibilityKey(PRINCIPAL, ROLE, '/'))
  })

  it('reports no diff when the live window matches a permanent eligibility', () => {
    const specs = extractEligibilitySpecs({ items: [{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE } }] } as never)
    const live: LiveEligibilitySchedule = { scheduleInfo: { expiration: { type: 'noExpiration' } } }
    expect(expirationDiff(specs[0], live)).toBeNull()
  })

  it('reports a diff when the live expiration type differs', () => {
    const specs = extractEligibilitySpecs({ items: [{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE } }] } as never)
    const live: LiveEligibilitySchedule = { scheduleInfo: { expiration: { type: 'afterDateTime', endDateTime: '2026-12-31T00:00:00Z' } } }
    const diff = expirationDiff(specs[0], live)
    expect(diff).toBeDefined()
    expect(diff?.expected).toBe('noExpiration')
  })

  it('treats equivalent ISO instants as no drift', () => {
    const specs = extractEligibilitySpecs({
      items: [{ fields: { principalId: PRINCIPAL, roleDefinitionId: ROLE, expirationType: 'afterDateTime', endDateTime: '2026-12-31T00:00:00Z' } }],
    } as never)
    const live: LiveEligibilitySchedule = { scheduleInfo: { expiration: { type: 'afterDateTime', endDateTime: '2026-12-31T00:00:00.000Z' } } }
    expect(expirationDiff(specs[0], live)).toBeNull()
  })
})
