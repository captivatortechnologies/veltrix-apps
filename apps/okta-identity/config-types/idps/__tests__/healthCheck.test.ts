// =============================================================================
// idps — healthCheck, driven against the fake Okta org.
//
// A deleted IdP means every federated user is locked out, and this check is how
// an operator finds out. It must degrade into a FAILED check rather than
// throwing, and must never print the SSWS token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  EMPTY_LIST,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function idp(name: string, type = 'OIDC'): CanvasItemInput {
  return { name, fields: { type, name, status: 'ACTIVE' } }
}

const LIVE = { id: 'idp-1', name: 'Partner OIDC', type: 'OIDC', status: 'ACTIVE' }

describe('idps healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [idp('Partner OIDC')], credential: null }),
      )

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].passed).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [idp('Partner OIDC')], hostname: '' }))

      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any IdP', async () => {
    await withFetch([ok({ companyName: 'Acme' }), ok([LIVE])], async (calls) => {
      await healthCheck(healthContext({ sections: [idp('Partner OIDC')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [idp('Partner OIDC')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a 403 on the org probe as a rejected token too', async () => {
    const result = await withFetch([apiError('You do not have permission', 403)], async () =>
      healthCheck(healthContext({ sections: [idp('Partner OIDC')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/admin with read access/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [idp('Partner OIDC')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared IdP and scores 100 when all are present', async () => {
    const result = await withFetch(
      [
        ok({ companyName: 'Acme' }),
        ok([LIVE]),
        ok([{ id: 'idp-2', name: 'Corp SAML', type: 'SAML2', status: 'ACTIVE' }]),
      ],
      async () =>
        healthCheck(healthContext({ sections: [idp('Partner OIDC'), idp('Corp SAML', 'SAML2')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('idp:Partner OIDC')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared IdP that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), ok([LIVE]), EMPTY_LIST],
      async () =>
        healthCheck(healthContext({ sections: [idp('Partner OIDC'), idp('Corp SAML', 'SAML2')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'idp:Corp SAML')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-IdP lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [idp('Partner OIDC')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list IdPs/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not accept a case-variant name as the declared IdP', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), ok([{ ...LIVE, name: 'partner oidc' }])],
      async () => healthCheck(healthContext({ sections: [idp('Partner OIDC')] })),
    )

    expect(result.checks[1].passed).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no IdPs', async () => {
    const result = await withFetch([ok({ companyName: 'Acme' })], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('skips a section with no name or type', async () => {
    const result = await withFetch([ok({ companyName: 'Acme' })], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'Blank', fields: { type: '', name: '' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.healthy).toBe(true)
  })
})
