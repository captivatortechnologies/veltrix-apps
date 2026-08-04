import validate, { mapCanvasStateToGraph, asStringArray, extractPolicySpecs } from '../validate'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const validFields = {
  name: 'Require MFA for all',
  state: 'report-only',
  includeAllUsers: true,
  includeAllApps: true,
  grantOperator: 'OR',
  builtInControls: ['mfa'],
}

describe('conditional-access-policies validate', () => {
  it('accepts a valid report-only MFA policy', () => {
    const r = validate(ctxWith([{ name: validFields.name, fields: { ...validFields } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { ...validFields, name: '' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid state', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', state: 'on' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_state')).toBe(true)
  })

  it('requires a user target', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', includeAllUsers: false, includeGroups: '' } }])
    )
    expect(r.errors.some((e) => e.code === 'no_user_target')).toBe(true)
  })

  it('accepts a user target satisfied by Included Users alone', () => {
    const r = validate(
      ctxWith([
        {
          name: 'P',
          fields: { ...validFields, name: 'P', includeAllUsers: false, includeGroups: '', includeUsers: ['u-1'] },
        },
      ])
    )
    expect(r.errors.some((e) => e.code === 'no_user_target')).toBe(false)
  })

  it('accepts a user target satisfied by Included Roles alone', () => {
    const r = validate(
      ctxWith([
        {
          name: 'P',
          fields: { ...validFields, name: 'P', includeAllUsers: false, includeGroups: '', includeRoles: ['r-1'] },
        },
      ])
    )
    expect(r.errors.some((e) => e.code === 'no_user_target')).toBe(false)
  })

  it('requires an app target', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', includeAllApps: false, includeApps: '' } }])
    )
    expect(r.errors.some((e) => e.code === 'no_app_target')).toBe(true)
  })

  it('requires at least one grant control', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', builtInControls: [] } }]))
    expect(r.errors.some((e) => e.code === 'no_grant_control')).toBe(true)
  })

  it('rejects block combined with other controls', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', builtInControls: ['block', 'mfa'] } }])
    )
    expect(r.errors.some((e) => e.code === 'block_not_exclusive')).toBe(true)
  })

  it('rejects an unknown grant control', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', builtInControls: ['telepathy'] } }])
    )
    expect(r.errors.some((e) => e.code === 'invalid_grant_control')).toBe(true)
  })

  it('warns when an enabled policy has no break-glass exclusion', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', state: 'enabled' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_break_glass')).toBe(true)
  })

  it('does not warn when the break-glass exclusion is an excluded user', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', state: 'enabled', excludeUsers: ['breakglass@contoso.com'] } }])
    )
    expect(r.warnings.some((w) => w.code === 'no_break_glass')).toBe(false)
  })

  it('does not warn when the break-glass exclusion is an excluded role', () => {
    const r = validate(
      ctxWith([{ name: 'P', fields: { ...validFields, name: 'P', state: 'enabled', excludeRoles: ['role-1'] } }])
    )
    expect(r.warnings.some((w) => w.code === 'no_break_glass')).toBe(false)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { ...validFields, name: 'Dup' } },
        { name: 'Dup', fields: { ...validFields, name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('mapCanvasStateToGraph', () => {
  it('maps canvas states to Graph states, defaulting to report-only', () => {
    expect(mapCanvasStateToGraph('enabled')).toBe('enabled')
    expect(mapCanvasStateToGraph('disabled')).toBe('disabled')
    expect(mapCanvasStateToGraph('report-only')).toBe('enabledForReportingButNotEnforced')
    expect(mapCanvasStateToGraph('anything-else')).toBe('enabledForReportingButNotEnforced')
  })
})

describe('asStringArray', () => {
  it('coerces arrays and delimited strings alike', () => {
    expect(asStringArray(['a', ' b '])).toEqual(['a', 'b'])
    expect(asStringArray('a\nb, c')).toEqual(['a', 'b', 'c'])
    expect(asStringArray('')).toEqual([])
    expect(asStringArray(undefined)).toEqual([])
  })
})

describe('extractPolicySpecs — Phase 2 targeting fields', () => {
  it('extracts includeUsers/excludeUsers, includeRoles/excludeRoles, includeLocations/excludeLocations, authenticationStrength and termsOfUse', () => {
    const canvas = {
      items: [
        {
          id: 'item-1',
          name: 'P',
          fields: {
            ...validFields,
            name: 'P',
            includeUsers: ['All'],
            excludeUsers: ['GuestsOrExternalUsers'],
            includeRoles: ['role-1'],
            excludeRoles: ['role-2'],
            includeLocations: ['AllTrusted'],
            excludeLocations: ['loc-1'],
            authenticationStrength: 'auth-strength-1',
            termsOfUse: ['tou-1', 'tou-2'],
          },
        },
      ],
    } as unknown as CanvasSnapshot

    const [spec] = extractPolicySpecs(canvas)
    expect(spec.includeUsers).toEqual(['All'])
    expect(spec.excludeUsers).toEqual(['GuestsOrExternalUsers'])
    expect(spec.includeRoles).toEqual(['role-1'])
    expect(spec.excludeRoles).toEqual(['role-2'])
    expect(spec.includeLocations).toEqual(['AllTrusted'])
    expect(spec.excludeLocations).toEqual(['loc-1'])
    expect(spec.authenticationStrength).toBe('auth-strength-1')
    expect(spec.termsOfUse).toEqual(['tou-1', 'tou-2'])
  })

  it('defaults every Phase 2 field to empty when absent (backward compatible with pre-Phase-2 canvases)', () => {
    const canvas = { items: [{ id: 'item-1', name: 'P', fields: { ...validFields, name: 'P' } }] } as unknown as CanvasSnapshot
    const [spec] = extractPolicySpecs(canvas)
    expect(spec.includeUsers).toEqual([])
    expect(spec.excludeUsers).toEqual([])
    expect(spec.includeRoles).toEqual([])
    expect(spec.excludeRoles).toEqual([])
    expect(spec.includeLocations).toEqual([])
    expect(spec.excludeLocations).toEqual([])
    expect(spec.authenticationStrength).toBe('')
    expect(spec.termsOfUse).toEqual([])
  })
})
