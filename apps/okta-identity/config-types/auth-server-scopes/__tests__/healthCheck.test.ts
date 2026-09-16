// =============================================================================
// auth-server-scopes — healthCheck, driven against the fake Okta org.
//
// This is what tells an operator that a scope their clients request has been
// deleted — every token asking for it now fails — or that its parent
// authorization server is gone. It must degrade to a FAILED check rather than
// throwing, and must never print the SSWS token.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  EMPTY_LIST,
  healthContext,
  leaksToken,
  notFound,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function scope(name: string, authServerId = 'default'): CanvasItemInput {
  return { name, fields: { authServerId, name } }
}

const live = (name: string): Record<string, unknown> => ({ id: `scp-${name}`, name, consent: 'IMPLICIT' })

describe('auth-server-scopes healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [scope('partner.read')], credential: null }),
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
        healthContext({ sections: [scope('partner.read')], hostname: '' }),
      )

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any scope', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('partner.read')])], async (calls) => {
      await healthCheck(healthContext({ sections: [scope('partner.read')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [scope('partner.read')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].message).toMatch(/token/i)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [scope('partner.read')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared scope and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({}), ok([live('partner.read')]), ok([live('partner.write')])],
      async () =>
        healthCheck(healthContext({ sections: [scope('partner.read'), scope('partner.write')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('scope:default:partner.read')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared scope that no longer exists', async () => {
    const result = await withFetch([ok({}), ok([live('partner.read')]), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [scope('partner.read'), scope('partner.gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'scope:default:partner.gone')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist on authorization server "default"/)
  })

  it('fails the check — without throwing — when the parent authorization server is gone', async () => {
    const result = await withFetch([ok({}), notFound()], async () =>
      healthCheck(healthContext({ sections: [scope('partner.read', 'ausGONE')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(2)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list scopes on authorization server "ausGONE"/)
  })

  it('turns a per-scope lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      healthCheck(healthContext({ sections: [scope('partner.read')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not check a section the validator would have rejected', async () => {
    const result = await withFetch([ok({})], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'Bad', fields: { name: 'orphan.scope' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('is healthy with just the org probe when the canvas declares no scopes', async () => {
    const result = await withFetch([ok({})], async () => healthCheck(healthContext({ sections: [] })))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })
})
