// =============================================================================
// resource-sets — healthCheck, driven against the fake Okta org.
//
// A resource set that has been deleted takes the grants pointing at it with it.
// The check must surface that as a failed check rather than an exception, and
// must never print the SSWS token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function resourceSet(label: string): CanvasItemInput {
  return {
    name: label,
    fields: {
      label,
      description: 'What Tier 1 may touch',
      resources: ['orn:okta:directory:00o1:groups'],
    },
  }
}

function setsList(sets: unknown[]) {
  return ok({ 'resource-sets': sets })
}

const LIVE_SET = { id: 'iamLIVE', label: 'Helpdesk scope', description: 'What Tier 1 may touch' }

describe('resource-sets healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [resourceSet('Helpdesk scope')], credential: null }),
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
        healthContext({ sections: [resourceSet('Helpdesk scope')], hostname: '' }),
      )

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any resource set', async () => {
    await withFetch([ok({ id: 'org1' }), setsList([LIVE_SET])], async (calls) => {
      await healthCheck(healthContext({ sections: [resourceSet('Helpdesk scope')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [resourceSet('Helpdesk scope')] }))
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
      healthCheck(healthContext({ sections: [resourceSet('Helpdesk scope')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [resourceSet('Helpdesk scope')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared set and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), setsList([LIVE_SET, { id: 'iamTWO', label: 'Tier 2 scope' }])],
      async (calls) => {
        const res = await healthCheck(
          healthContext({ sections: [resourceSet('Helpdesk scope'), resourceSet('Tier 2 scope')] }),
        )
        expect(calls).toHaveLength(2)
        return res
      },
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('resource-set:Helpdesk scope')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared set that no longer exists in the org', async () => {
    const result = await withFetch([ok({ id: 'org1' }), setsList([LIVE_SET])], async () =>
      healthCheck(
        healthContext({ sections: [resourceSet('Helpdesk scope'), resourceSet('Deleted scope')] }),
      ),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'resource-set:Deleted scope')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a failing set list into a failed check per set instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () =>
        healthCheck(
          healthContext({ sections: [resourceSet('Helpdesk scope'), resourceSet('Tier 2 scope')] }),
        ),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    expect(result.checks[2].passed).toBe(false)
    expect(result.score).toBe(33)
    expect(leaksToken(result)).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no resource sets', async () => {
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
