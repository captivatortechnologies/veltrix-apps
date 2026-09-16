// =============================================================================
// email-domains — healthCheck, driven against the fake Okta org.
//
// A custom email domain that has disappeared is a password-reset channel that
// has disappeared, and nobody finds out until someone locked out complains. The
// check must report that as a failed check with the domain's validation status,
// never throw, and never print the SSWS token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  EMPTY_LIST,
  apiError,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function emailDomain(domain: string): CanvasItemInput {
  return {
    name: `${domain} mail`,
    fields: { domain, brandId: 'brd-1', displayName: 'Acme', userName: 'no-reply' },
  }
}

const ACME = { id: 'eml-live', domain: 'mail.acme.test', validationStatus: 'VERIFIED' }
const PARTNER = { id: 'eml-two', domain: 'mail.partner.test', validationStatus: 'VERIFIED' }

describe('email-domains healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [emailDomain('mail.acme.test')], credential: null }),
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
      const result = await healthCheck(
        healthContext({ sections: [emailDomain('mail.acme.test')], hostname: '' }),
      )

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any domain', async () => {
    await withFetch([ok({ id: 'org1' }), ok([ACME])], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [emailDomain('mail.acme.test')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [emailDomain('mail.acme.test')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/token/i)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [emailDomain('mail.acme.test')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared domain and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([ACME, PARTNER]), ok([ACME, PARTNER])],
      async () =>
        healthCheck(
          healthContext({
            sections: [emailDomain('mail.acme.test'), emailDomain('mail.partner.test')],
          }),
        ),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('email-domain:mail.acme.test')
    expect(result.checks[1].passed).toBe(true)
  })

  it('surfaces a domain that is present but still unverified', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([{ ...ACME, validationStatus: 'IN_PROGRESS' }])],
      async () => healthCheck(healthContext({ sections: [emailDomain('mail.acme.test')] })),
    )

    // Presence is the check; the pending handshake is reported in the message so
    // an operator is not told a mail channel that cannot send yet is simply fine.
    expect(result.checks[1].passed).toBe(true)
    expect(result.checks[1].message).toMatch(/validationStatus=IN_PROGRESS/)
  })

  it('fails the check for a declared domain that no longer exists in the org', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok([ACME]), EMPTY_LIST], async () =>
      healthCheck(
        healthContext({ sections: [emailDomain('mail.acme.test'), emailDomain('mail.partner.test')] }),
      ),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'email-domain:mail.partner.test')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-domain lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [emailDomain('mail.acme.test')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list email domains/)
  })

  it('is healthy with just the org probe when the canvas declares no domains', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })
})
