// =============================================================================
// trusted-origins — healthCheck, driven against the fake Okta org.
//
// A trusted origin that has disappeared breaks every app that signs in through
// it; one that reappears unexpectedly is a new cross-origin caller. This tells
// an operator which it is, and must degrade to a FAILED check rather than throw.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function origin(name: string): CanvasItemInput {
  return {
    name,
    fields: {
      name,
      origin: 'https://app.example.com',
      scopes: ['CORS'],
      status: 'ACTIVE',
    },
  }
}

const LIVE_ORIGIN = {
  id: 'tosLIVE',
  name: 'Corp SPA',
  origin: 'https://app.example.com',
  scopes: [{ type: 'CORS' }],
  status: 'ACTIVE',
}

describe('trusted-origins healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [origin('Corp SPA')], credential: null }),
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
      const result = await healthCheck(healthContext({ sections: [origin('Corp SPA')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any origin', async () => {
    await withFetch([ok({ id: 'org1' }), ok([LIVE_ORIGIN])], async (calls) => {
      await healthCheck(healthContext({ sections: [origin('Corp SPA')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [origin('Corp SPA')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].message).toMatch(/token/i)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a 403 on the org probe as a rejected token too', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      healthCheck(healthContext({ sections: [origin('Corp SPA')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [origin('Corp SPA')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared origin and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([LIVE_ORIGIN]), ok([{ id: 'tosTWO', name: 'Partner SPA' }])],
      async () => healthCheck(healthContext({ sections: [origin('Corp SPA'), origin('Partner SPA')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('trustedOrigin:Corp SPA')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared origin that no longer exists in the org', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok([LIVE_ORIGIN]), ok([])], async () =>
      healthCheck(healthContext({ sections: [origin('Corp SPA'), origin('Deleted SPA')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'trustedOrigin:Deleted SPA')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-origin lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [
        ok({ id: 'org1' }),
        apiError('Insufficient permissions', 403),
        ok([{ id: 'tosTWO', name: 'Partner SPA' }]),
      ],
      async () => healthCheck(healthContext({ sections: [origin('Corp SPA'), origin('Partner SPA')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    // One broken lookup does not abort the rest.
    expect(result.checks[2].passed).toBe(true)
    expect(result.score).toBe(67)
    expect(leaksToken(result)).toBe(false)
  })

  it('follows the Link header so an origin on a later page still passes its check', async () => {
    const result = await withFetch(
      [
        ok({ id: 'org1' }),
        {
          status: 200,
          body: [{ id: 'tosOTHER', name: 'Somewhere else' }],
          headers: { link: `<${API_BASE}/trustedOrigins?after=tosOTHER>; rel="next"` },
        },
        ok([LIVE_ORIGIN]),
      ],
      async () => healthCheck(healthContext({ sections: [origin('Corp SPA')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
  })

  it('skips a section that grants no scope', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async (calls) => {
      const res = await healthCheck(
        healthContext({
          sections: [{ name: 'Half done', fields: { name: 'Corp SPA', origin: 'https://app.example.com' } }],
        }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.healthy).toBe(true)
  })

  it('is healthy with just the org probe when the canvas declares no origins', async () => {
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
