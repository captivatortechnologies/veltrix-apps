// =============================================================================
// event-hooks — healthCheck, driven against the fake Okta org.
//
// A hook that quietly disappeared takes an outbound event feed with it, and the
// health check is the only thing that notices. It must degrade to a FAILED check
// rather than throwing, and must never print the SSWS token or the hook secret
// into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  healthContext,
  leaksToken,
  EMPTY_LIST,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const SECRET = 'hook-auth-SUPERSECRET-value'

function hook(name: string): CanvasItemInput {
  return {
    name,
    fields: {
      name,
      status: 'ACTIVE',
      eventItems: ['user.lifecycle.create'],
      uri: 'https://hooks.example.com/okta',
      authHeaderValue: SECRET,
    },
  }
}

const live = (name: string): Record<string, unknown> => ({
  id: 'eh1',
  name,
  status: 'ACTIVE',
  events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create'] },
  channel: { type: 'HTTP', version: '1.0.0', config: { uri: 'https://hooks.example.com/okta' } },
})

describe('event-hooks healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [hook('A')], credential: null }))

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
      const result = await healthCheck(healthContext({ sections: [hook('A')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before listing any hook', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('A')])], async (calls) => {
      await healthCheck(healthContext({ sections: [hook('A')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [hook('A')] }))
      // No point asking an org that just rejected us about individual hooks.
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

  it('treats a 403 on the org probe as a rejected token too', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      healthCheck(healthContext({ sections: [hook('A')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [hook('A')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared hook and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('A')]), ok([live('B')])],
      async () => healthCheck(healthContext({ sections: [hook('A'), hook('B')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('event-hook:A')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared hook that no longer exists in the org', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok([live('A')]), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [hook('A'), hook('Gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'event-hook:Gone')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a failed hook listing into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [hook('A')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list event hooks/)
    expect(leaksToken(result)).toBe(false)
    expect(JSON.stringify(result).includes(SECRET)).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no hooks', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async () =>
      healthCheck(healthContext({ sections: [] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('never writes anything — a health check must not change the org', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('A')])], async (calls) => {
      await healthCheck(healthContext({ sections: [hook('A')] }))
      expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
    })
  })
})
