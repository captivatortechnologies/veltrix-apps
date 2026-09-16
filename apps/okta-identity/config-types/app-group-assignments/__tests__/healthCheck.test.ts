// =============================================================================
// app-group-assignments — healthCheck, driven against the fake Okta org.
//
// An assignment that has been removed out of band silently takes an application
// away from everyone in the group. The check must report that as a failed check
// rather than throwing, and must never print the SSWS token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  healthContext,
  leaksToken,
  notFound,
  ok,
  unauthorized,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function assignment(groupId: string, appId = '0oaAPP'): CanvasItemInput {
  return { name: `${appId}:${groupId}`, fields: { appId, groupId } }
}

describe('app-group-assignments healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [assignment('00gENG')], credential: null }),
      )

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [assignment('00gENG')], credential: emptyCredential() }),
      )
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [assignment('00gENG')], hostname: '' }))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any assignment', async () => {
    await withFetch([ok({ id: 'org1' }), ok({ id: '00gENG' })], async (calls) => {
      await healthCheck(healthContext({ sections: [assignment('00gENG')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[1].path).toBe('/apps/0oaAPP/groups/00gENG')
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [assignment('00gENG')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].message).toMatch(/SSWS/)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a 403 the same as a 401 — the token cannot read the org', async () => {
    const result = await withFetch([apiError('Forbidden', 403)], async () =>
      healthCheck(healthContext({ sections: [assignment('00gENG')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/read access/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [assignment('00gENG')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared assignment and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok({ id: '00gENG' }), ok({ id: '00gSALES' })],
      async () =>
        healthCheck(healthContext({ sections: [assignment('00gENG'), assignment('00gSALES')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('assignment:0oaAPP:00gENG')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a group that is no longer assigned to the app', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok({ id: '00gENG' }), notFound()],
      async () =>
        healthCheck(healthContext({ sections: [assignment('00gENG'), assignment('00gGONE')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'assignment:0oaAPP:00gGONE')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/is not assigned to app/)
  })

  it('turns a per-assignment lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [assignment('00gENG')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to fetch assignment/)
    expect(leaksToken(result)).toBe(false)
  })

  it('skips a section missing an app id or a group id', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'incomplete', fields: { appId: '0oaAPP' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('writes nothing — a health check must never change the org', async () => {
    await withFetch([ok({ id: 'org1' }), ok({ id: '00gENG' })], async (calls) => {
      await healthCheck(healthContext({ sections: [assignment('00gENG')] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })
})
