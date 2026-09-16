// =============================================================================
// features — healthCheck, driven against the fake Okta org.
//
// A declared feature that no longer appears in the org means the toggle this
// canvas owns has nothing to act on — either it was renamed by Okta or the token
// lost the scope that lists it. Either way the check must fail rather than throw,
// and must never print the SSWS token into a check message.
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

function feature(name: string): CanvasItemInput {
  return { name, fields: { name, status: 'ENABLED', forceDependencies: false } }
}

const live = (name: string, status = 'ENABLED'): Record<string, unknown> => ({
  id: 'ft1',
  name,
  type: 'self-service',
  status,
  stage: { state: 'OPEN', value: 'EA' },
})

describe('features healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [feature('A')], credential: null }))

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
      const result = await healthCheck(healthContext({ sections: [feature('A')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before listing any feature', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('A')])], async (calls) => {
      await healthCheck(healthContext({ sections: [feature('A')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [feature('A')] }))
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
      healthCheck(healthContext({ sections: [feature('A')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared feature and reports its live status', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('A')]), ok([live('B', 'DISABLED')])],
      async () => healthCheck(healthContext({ sections: [feature('A'), feature('B')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('feature:A')
    expect(result.checks[1].message).toMatch(/status=ENABLED/)
    // Presence is what is checked — a feature toggled off out of band is drift,
    // not ill health.
    expect(result.checks[2].passed).toBe(true)
    expect(result.checks[2].message).toMatch(/status=DISABLED/)
  })

  it('fails the check for a declared feature that no longer exists in the org', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok([live('A')]), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [feature('A'), feature('Gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'feature:Gone')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a failed feature listing into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [feature('A')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list features/)
    expect(leaksToken(result)).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no features', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async () =>
      healthCheck(healthContext({ sections: [] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('never writes anything — a health check must not toggle a feature', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('A')])], async (calls) => {
      await healthCheck(healthContext({ sections: [feature('A')] }))
      expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
    })
  })
})
