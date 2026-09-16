// =============================================================================
// auth-server-claims — healthCheck, driven against the fake Okta org.
//
// This is what tells an operator that a claim downstream services authorize on
// has vanished from the token — or that its parent authorization server is gone.
// It must degrade to a FAILED check rather than throwing, and must never print
// the SSWS token.
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

function claim(name: string, authServerId = 'default'): CanvasItemInput {
  return {
    name,
    fields: { authServerId, name, claimType: 'RESOURCE', valueType: 'EXPRESSION', value: `user.${name}` },
  }
}

const live = (name: string): Record<string, unknown> => ({
  id: `ocl-${name}`,
  name,
  status: 'ACTIVE',
  claimType: 'RESOURCE',
})

describe('auth-server-claims healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [claim('department')], credential: null }),
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
        healthContext({ sections: [claim('department')], hostname: '' }),
      )

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any claim', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('department')])], async (calls) => {
      await healthCheck(healthContext({ sections: [claim('department')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [claim('department')] }))
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
      healthCheck(healthContext({ sections: [claim('department')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared claim and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({}), ok([live('department')]), ok([live('costCenter')])],
      async () =>
        healthCheck(healthContext({ sections: [claim('department'), claim('costCenter')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('claim:default:department')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared claim that no longer exists', async () => {
    const result = await withFetch([ok({}), ok([live('department')]), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [claim('department'), claim('gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'claim:default:gone')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist under authorization server "default"/)
  })

  it('fails the check — without throwing — when the parent authorization server is gone', async () => {
    const result = await withFetch([ok({}), notFound()], async () =>
      healthCheck(healthContext({ sections: [claim('department', 'ausGONE')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(2)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list claims for authorization server "ausGONE"/)
  })

  it('turns a per-claim lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      healthCheck(healthContext({ sections: [claim('department')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not check a section the validator would have rejected', async () => {
    const result = await withFetch([ok({})], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'Bad', fields: { name: 'orphan' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('is healthy with just the org probe when the canvas declares no claims', async () => {
    const result = await withFetch([ok({})], async () => healthCheck(healthContext({ sections: [] })))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })
})
