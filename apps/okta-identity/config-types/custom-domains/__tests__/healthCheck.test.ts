// =============================================================================
// custom-domains — healthCheck, driven against the fake Okta org.
//
// A custom domain that has vanished from the org means the branded login URL no
// longer resolves to anything. The check must report that as a failed check and
// surface the domain's validation status, never throw, and never print the SSWS
// token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function domain(name: string): CanvasItemInput {
  return { name: `${name} URL`, fields: { domain: name, certificateSourceType: 'OKTA_MANAGED' } }
}

function domainList(domains: unknown[]) {
  return ok({ domains })
}

const ACME = { id: 'dom-live', domain: 'login.acme.test', validationStatus: 'VERIFIED' }
const PARTNER = { id: 'dom-two', domain: 'login.partner.test', validationStatus: 'VERIFIED' }

describe('custom-domains healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [domain('login.acme.test')], credential: null }),
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
        healthContext({ sections: [domain('login.acme.test')], hostname: '' }),
      )

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any domain', async () => {
    await withFetch([ok({ id: 'org1' }), domainList([ACME])], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [domain('login.acme.test')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [domain('login.acme.test')] }))
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
      healthCheck(healthContext({ sections: [domain('login.acme.test')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared domain and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), domainList([ACME, PARTNER]), domainList([ACME, PARTNER])],
      async () =>
        healthCheck(
          healthContext({ sections: [domain('login.acme.test'), domain('login.partner.test')] }),
        ),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('custom-domain:login.acme.test')
    expect(result.checks[1].passed).toBe(true)
  })

  it('surfaces a domain that is present but still unverified', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), domainList([{ ...ACME, validationStatus: 'IN_PROGRESS' }])],
      async () => healthCheck(healthContext({ sections: [domain('login.acme.test')] })),
    )

    // Presence is the check; the pending DNS handshake is reported in the message
    // so an operator is not told a half-configured login URL is simply "fine".
    expect(result.checks[1].passed).toBe(true)
    expect(result.checks[1].message).toMatch(/validationStatus=IN_PROGRESS/)
  })

  it('reports an unknown validation status rather than inventing one', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), domainList([{ id: 'dom-live', domain: 'login.acme.test' }])],
      async () => healthCheck(healthContext({ sections: [domain('login.acme.test')] })),
    )

    expect(result.checks[1].message).toMatch(/validationStatus=unknown/)
  })

  it('fails the check for a declared domain that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), domainList([ACME]), domainList([ACME])],
      async () =>
        healthCheck(
          healthContext({ sections: [domain('login.acme.test'), domain('login.partner.test')] }),
        ),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'custom-domain:login.partner.test')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-domain lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [domain('login.acme.test')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list custom domains/)
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
