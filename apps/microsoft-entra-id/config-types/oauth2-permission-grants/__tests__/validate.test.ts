import validate, { grantKey, normalizeScope } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('oauth2-permission-grants validate', () => {
  it('accepts a valid all-principals grant', () => {
    const r = validate(
      ctxWith([{ fields: { clientId: 'c', resourceId: 'r', consentType: 'AllPrincipals', scope: 'User.Read' } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires client, resource and scope', () => {
    const r = validate(ctxWith([{ fields: { consentType: 'AllPrincipals' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.filter((e) => e.code === 'required').length).toBe(3)
  })

  it('requires principalId when consent type is Principal', () => {
    const r = validate(
      ctxWith([{ fields: { clientId: 'c', resourceId: 'r', consentType: 'Principal', scope: 'User.Read' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'principal_required')).toBe(true)
  })

  it('rejects duplicate composite keys', () => {
    const r = validate(
      ctxWith([
        { fields: { clientId: 'c', resourceId: 'r', consentType: 'AllPrincipals', scope: 'a' } },
        { fields: { clientId: 'c', resourceId: 'r', consentType: 'AllPrincipals', scope: 'b' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_grant')).toBe(true)
  })
})

describe('helpers', () => {
  it('normalizes scope order', () => {
    expect(normalizeScope('Mail.Read User.Read')).toBe(normalizeScope('User.Read Mail.Read'))
  })

  it('builds a stable composite key', () => {
    expect(grantKey({ clientId: 'C', resourceId: 'R', consentType: 'AllPrincipals', principalId: '' })).toBe(
      'c|r|allprincipals|',
    )
  })
})
