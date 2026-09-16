// =============================================================================
// auth-server-policies — healthCheck, driven against the fake Okta org.
//
// This is what tells an operator that the policy gating an authorization server
// has been removed, or that its parent server is gone. It must degrade to a
// FAILED check rather than throwing, and must never print the SSWS token.
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

function policy(name: string, authServerId = 'default'): CanvasItemInput {
  return { name, fields: { authServerId, name } }
}

const live = (name: string): Record<string, unknown> => ({
  id: `00p-${name}`,
  name,
  status: 'ACTIVE',
  conditions: { clients: { include: ['ALL_CLIENTS'] } },
})

describe('auth-server-policies healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [policy('Partner access')], credential: null }),
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
        healthContext({ sections: [policy('Partner access')], hostname: '' }),
      )

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any policy', async () => {
    await withFetch(
      [ok({ companyName: 'Acme' }), ok([live('Partner access')])],
      async (calls) => {
        const result = await healthCheck(healthContext({ sections: [policy('Partner access')] }))

        expect(calls[0].path).toBe('/org')
        expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
        expect(result.checks[0].message).toMatch(/org: Acme/)
      },
    )
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [policy('Partner access')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].message).toMatch(/rejected the API token/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [policy('Partner access')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared policy and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({}), ok([live('Partner access')]), ok([live('Internal access')])],
      async () =>
        healthCheck(
          healthContext({ sections: [policy('Partner access'), policy('Internal access')] }),
        ),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('policy:default:Partner access')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared policy that no longer exists', async () => {
    const result = await withFetch(
      [ok({}), ok([live('Partner access')]), EMPTY_LIST],
      async () =>
        healthCheck(healthContext({ sections: [policy('Partner access'), policy('Gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'policy:default:Gone')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('fails the check — without throwing — when the parent authorization server is gone', async () => {
    const result = await withFetch([ok({}), notFound()], async () =>
      healthCheck(healthContext({ sections: [policy('Partner access', 'ausGONE')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(2)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list policies for authorization server "ausGONE"/)
  })

  it('turns a per-policy lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({}), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [policy('Partner access')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not check a section the validator would have rejected', async () => {
    const result = await withFetch([ok({})], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'Bad', fields: { name: 'Orphan policy' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('is healthy with just the org probe when the canvas declares no policies', async () => {
    const result = await withFetch([ok({})], async () => healthCheck(healthContext({ sections: [] })))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })
})
