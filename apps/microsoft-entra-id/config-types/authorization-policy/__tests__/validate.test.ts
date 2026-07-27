import validate, { canonicalObject, extractAuthorizationPolicySpecs, parseObject } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('authorization-policy validate', () => {
  it('accepts an empty (do-not-manage) policy', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid enum and guest role', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            allowInvitesFrom: 'adminsAndGuestInviters',
            guestUserRoleId: '2af84b1e-32c8-42b7-82bc-daa82404023b',
            blockMsolPowerShell: true,
          },
        },
      ]),
    )
    expect(r.valid).toBe(true)
  })

  it('rejects an unknown allowInvitesFrom value', () => {
    const r = validate(ctxWith([{ fields: { allowInvitesFrom: 'anyone' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects an unknown guest role id', () => {
    const r = validate(ctxWith([{ fields: { guestUserRoleId: 'not-a-guid' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_guest_role')).toBe(true)
  })

  it('rejects invalid defaultUserRolePermissions JSON', () => {
    const r = validate(ctxWith([{ fields: { defaultUserRolePermissions: '{not json' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects more than one policy item', () => {
    const r = validate(ctxWith([{ fields: {} }, { fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('reads booleans as real booleans', () => {
    const specs = extractAuthorizationPolicySpecs({ items: [{ fields: { blockMsolPowerShell: true } }] } as never)
    expect(specs[0].blockMsolPowerShell).toBe(true)
    expect(specs[0].allowedToUseSSPR).toBe(false)
  })
})

describe('object helpers', () => {
  it('parses a JSON object and rejects arrays', () => {
    expect(parseObject('{"a":1}') !== null).toBe(true)
    expect(parseObject('[1,2]')).toBe(null)
  })

  it('canonicalizes equal objects regardless of key order', () => {
    expect(canonicalObject({ a: 1, b: 2 })).toBe(canonicalObject({ b: 2, a: 1 }))
  })
})
