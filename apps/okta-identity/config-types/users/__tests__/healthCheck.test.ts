// =============================================================================
// users — healthCheck, driven against the fake Okta org.
//
// The health check is what tells an operator an account has vanished or the
// admin token has been revoked. It must degrade to a FAILED check rather than
// throwing, and must never print the SSWS token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  leaksToken,
  notFound,
  ok,
  healthContext,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function user(login: string): CanvasItemInput {
  return {
    name: login,
    fields: { login, email: login, firstName: 'A', lastName: 'B', status: 'ACTIVE' },
  }
}

describe('users healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [user('a@example.com')], credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].passed).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any user', async () => {
    await withFetch([ok({ id: 'org1' }), ok({ id: '00u1', status: 'ACTIVE' })], async (calls) => {
      await healthCheck(healthContext({ sections: [user('a@example.com')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [user('a@example.com')] }))
      // The user checks are skipped once the org probe fails — no point asking
      // an org that just rejected us about individual accounts.
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
      healthCheck(healthContext({ sections: [user('a@example.com')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared user and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok({ id: '00u1', status: 'ACTIVE' }), ok({ id: '00u2', status: 'ACTIVE' })],
      async () =>
        healthCheck(healthContext({ sections: [user('a@example.com'), user('b@example.com')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('user:a@example.com')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared user that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok({ id: '00u1', status: 'ACTIVE' }), notFound()],
      async () =>
        healthCheck(healthContext({ sections: [user('a@example.com'), user('gone@example.com')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'user:gone@example.com')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-user lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [user('a@example.com')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
  })

  it('is healthy with just the org probe when the canvas declares no users', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async () =>
      healthCheck(healthContext({ sections: [] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })
})
