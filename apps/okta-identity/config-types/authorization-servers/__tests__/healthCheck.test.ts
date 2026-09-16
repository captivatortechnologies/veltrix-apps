// =============================================================================
// authorization-servers — healthCheck, driven against the fake Okta org.
//
// This is what tells an operator that the server minting their access tokens has
// been deleted, or that the admin token has been revoked. It must degrade to a
// FAILED check rather than throwing, and must never print the SSWS token.
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

function server(name: string): CanvasItemInput {
  return { name, fields: { name, audiences: [`api://${name}`], status: 'ACTIVE' } }
}

const live = (name: string): Record<string, unknown> => ({
  id: `aus-${name}`,
  name,
  audiences: [`api://${name}`],
  status: 'ACTIVE',
})

describe('authorization-servers healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [server('partner')], credential: null }),
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
      const result = await healthCheck(healthContext({ sections: [server('partner')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any server', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('partner')])], async (calls) => {
      await healthCheck(healthContext({ sections: [server('partner')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [server('partner')] }))
      // The per-server checks are skipped once the org probe fails.
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

  it('reports a 403 on the org probe as a rejected token too', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      healthCheck(healthContext({ sections: [server('partner')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [server('partner')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared server and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('partner')]), ok([live('internal')])],
      async () =>
        healthCheck(healthContext({ sections: [server('partner'), server('internal')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('authServer:partner')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared server that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('partner')]), EMPTY_LIST],
      async () => healthCheck(healthContext({ sections: [server('partner'), server('gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'authServer:gone')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-server lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [server('partner')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(2)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not check a section the validator would have rejected', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async (calls) => {
      const res = await healthCheck(
        healthContext({
          sections: [{ name: 'Bad', fields: { name: 'Bad', audiences: ['a', 'b'] } }],
        }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('is healthy with just the org probe when the canvas declares no servers', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async () =>
      healthCheck(healthContext({ sections: [] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })
})
