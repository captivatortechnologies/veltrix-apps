import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('feature-rollout-policies validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            name: 'Cloud MFA',
            feature: 'multiFactorAuthentication',
            isEnabled: true,
            isAppliedToOrganization: true,
          },
        },
      ]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and feature', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown feature', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', feature: 'timeTravel' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_feature')).toBe(true)
  })

  it('warns when not applied to organization (no group targeting managed)', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'X', feature: 'seamlessSso', isAppliedToOrganization: false } }]),
    )
    expect(r.warnings.some((w) => w.code === 'no_targets')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Dup', feature: 'seamlessSso' } },
        { fields: { name: 'Dup', feature: 'passwordHashSync' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})
