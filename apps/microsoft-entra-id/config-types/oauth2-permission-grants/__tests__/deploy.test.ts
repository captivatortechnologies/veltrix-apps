import { buildCreateBody, type ResolvedGrant } from '../deploy'

describe('buildCreateBody', () => {
  const base: ResolvedGrant = {
    clientId: 'sp-client-1',
    resourceId: 'sp-resource-1',
    consentType: 'AllPrincipals',
    principalId: '',
    scope: 'User.Read',
  }

  it('omits principalId for an AllPrincipals grant', () => {
    const body = buildCreateBody(base)
    expect(body).toEqual({
      clientId: 'sp-client-1',
      consentType: 'AllPrincipals',
      resourceId: 'sp-resource-1',
      scope: 'User.Read',
    })
    expect('principalId' in body).toBe(false)
  })

  it('includes the resolved principalId for a Principal grant', () => {
    const body = buildCreateBody({ ...base, consentType: 'Principal', principalId: 'user-1' })
    expect(body).toEqual({
      clientId: 'sp-client-1',
      consentType: 'Principal',
      resourceId: 'sp-resource-1',
      principalId: 'user-1',
      scope: 'User.Read',
    })
  })
})
