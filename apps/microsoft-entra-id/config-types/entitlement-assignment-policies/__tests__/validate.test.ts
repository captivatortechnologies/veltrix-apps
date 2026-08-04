import validate, { canonical, parseArray, parseObject } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('entitlement-assignment-policies validate', () => {
  it('accepts a valid policy', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            name: 'Standard',
            accessPackageId: 'Sales reps',
            allowedTargetScope: 'allMemberUsers',
            expiration: '{"type":"noExpiration"}',
          },
        },
      ]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name and access package', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'required').length).toBe(2)
  })

  it('rejects an invalid target scope', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', accessPackageId: 'P', allowedTargetScope: 'everyone' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_target_scope')).toBe(true)
  })

  it('accepts every documented allowedTargetScope value, including the three newly added ones', () => {
    const scopes = [
      'notSpecified',
      'specificDirectoryUsers',
      'specificConnectedOrganizationUsers',
      'specificDirectoryServicePrincipals',
      'allMemberUsers',
      'allDirectoryUsers',
      'allDirectoryServicePrincipals',
      'allConfiguredConnectedOrganizationUsers',
      'allExternalUsers',
      'allDirectoryAgentIdentities',
    ]
    for (const allowedTargetScope of scopes) {
      const r = validate(ctxWith([{ fields: { name: `X-${allowedTargetScope}`, accessPackageId: 'P', allowedTargetScope } }]))
      expect(r.errors.filter((e) => e.code === 'invalid_target_scope')).toHaveLength(0)
    }
  })

  it('warns (not errors) when a "specific*" scope has no Specific Targets populated', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', accessPackageId: 'P', allowedTargetScope: 'specificDirectoryUsers' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_specific_targets')).toBe(true)
  })

  it('does not warn when a "specific*" scope has a Specific Targets field populated', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            name: 'X',
            accessPackageId: 'P',
            allowedTargetScope: 'specificDirectoryUsers',
            specificTargetUsers: ['11111111-1111-1111-1111-111111111111'],
          },
        },
      ]),
    )
    expect(r.warnings).toHaveLength(0)
  })

  it('rejects invalid expiration JSON', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', accessPackageId: 'P', expiration: '{bad' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an approvalStagesOverride that is not a JSON array', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', accessPackageId: 'P', approvalStagesOverride: '{"not":"an array"}' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json' && e.field.includes('approvalStagesOverride'))).toBe(true)
  })

  it('accepts a valid approvalStagesOverride array', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            name: 'X',
            accessPackageId: 'P',
            approvalStagesOverride: '[{"primaryApprovers":[{"@odata.type":"#microsoft.graph.requestorManager"}]}]',
          },
        },
      ]),
    )
    expect(r.valid).toBe(true)
  })

  it('rejects duplicate policy names for the same package', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Dup', accessPackageId: 'P' } },
        { fields: { name: 'Dup', accessPackageId: 'P' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('helpers', () => {
  it('canonicalizes settings independent of key order', () => {
    expect(canonical(parseObject('{"a":1,"b":2}'))).toBe(canonical(parseObject('{"b":2,"a":1}')))
  })

  it('parseArray rejects a non-array and accepts an array', () => {
    expect(parseArray('{"a":1}')).toBeNull()
    expect(parseArray('[]')).toEqual([])
    expect(parseArray('[{"a":1}]')).toEqual([{ a: 1 }])
  })
})
