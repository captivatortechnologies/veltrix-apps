// =============================================================================
// groups — healthCheck, driven against the fake Okta org.
//
// This is what tells an operator a group backing an access grant has been
// deleted, or that the admin token has been revoked. It must degrade to a FAILED
// check rather than throwing, and must never print the SSWS token into a check
// message that lands in a deployment log.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  EMPTY_LIST,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function group(name: string): CanvasItemInput {
  return { name: `${name} section`, fields: { name, description: '', manageMembership: false } }
}

const live = (id: string, name: string, type = 'OKTA_GROUP'): Record<string, unknown> => ({
  id,
  type,
  profile: { name, description: '' },
})

describe('groups healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [group('Engineering')], credential: null }),
      )

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].passed).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [group('Engineering')], credential: emptyCredential() }),
      )
      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [group('Engineering')], hostname: '' }))
      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before listing any group', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('00g1', 'Engineering')])], async (calls) => {
      await healthCheck(healthContext({ sections: [group('Engineering')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [group('Engineering')] }))
      // The group checks are skipped once the org probe fails.
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/token/i)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a 403 the same as a 401 — the token cannot read the org', async () => {
    const result = await withFetch([apiError('Forbidden', 403)], async () =>
      healthCheck(healthContext({ sections: [group('Engineering')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/lacks admin read/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [group('Engineering')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('folds a rejected group listing into the reachability check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [group('Engineering')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].message).toMatch(/Failed to list OKTA_GROUP groups/)
  })

  it('passes a check per declared group and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('00g1', 'Engineering'), live('00g2', 'Sales')])],
      async () => healthCheck(healthContext({ sections: [group('Engineering'), group('Sales')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('group:Engineering')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared group that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('00g1', 'Engineering')])],
      async () => healthCheck(healthContext({ sections: [group('Engineering'), group('Gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'group:Gone')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist as an OKTA_GROUP/)
  })

  it('fails the check when the name is now owned by a group of another type', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('00gAPP', 'Engineering', 'APP_GROUP')])],
      async () => healthCheck(healthContext({ sections: [group('Engineering')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no groups', async () => {
    const result = await withFetch([ok({ id: 'org1' }), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('writes nothing — a health check must never change the org', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('00g1', 'Engineering')])], async (calls) => {
      await healthCheck(healthContext({ sections: [group('Engineering')] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })
})
