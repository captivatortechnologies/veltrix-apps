// =============================================================================
// resource-set-bindings — healthCheck, driven against the fake Okta org.
//
// A binding disappears the moment its last member is unassigned, and with it the
// whole grant. This is what tells an operator that happened, so it must report a
// missing binding as a FAILED check rather than throwing, and never print the
// SSWS token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  healthContext,
  leaksToken,
  notFound,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const RESOURCE_SET = 'Helpdesk scope'

function binding(role: string): CanvasItemInput {
  return {
    name: role,
    fields: {
      resourceSet: RESOURCE_SET,
      role,
      members: ['https://dev-12345.okta.com/api/v1/groups/00g1'],
    },
  }
}

describe('resource-set-bindings healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [binding('cr0HELPDESK')], credential: null }),
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
        healthContext({ sections: [binding('cr0HELPDESK')], hostname: '' }),
      )

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any binding', async () => {
    await withFetch([ok({ id: 'org1' }), ok({ id: 'bnd1' })], async (calls) => {
      await healthCheck(healthContext({ sections: [binding('cr0HELPDESK')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [binding('cr0HELPDESK')] }))
      // The binding checks are skipped once the org probe fails.
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
      healthCheck(healthContext({ sections: [binding('cr0HELPDESK')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [binding('cr0HELPDESK')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared binding and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok({ id: 'bnd1' }), ok({ id: 'bnd2' })],
      async () =>
        healthCheck(healthContext({ sections: [binding('cr0HELPDESK'), binding('cr0TIER2')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe(`binding:${RESOURCE_SET}:cr0HELPDESK`)
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a binding whose last member was unassigned', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok({ id: 'bnd1' }), notFound()], async () =>
      healthCheck(healthContext({ sections: [binding('cr0HELPDESK'), binding('cr0GONE')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === `binding:${RESOURCE_SET}:cr0GONE`)
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-binding lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403), ok({ id: 'bnd2' })],
      async () =>
        healthCheck(healthContext({ sections: [binding('cr0HELPDESK'), binding('cr0TIER2')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    // One broken binding does not abort the rest.
    expect(result.checks[2].passed).toBe(true)
    expect(result.score).toBe(67)
    expect(leaksToken(result)).toBe(false)
  })

  it('checks a binding even when the canvas section declares no members', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok({ id: 'bnd1' })], async () =>
      healthCheck(
        healthContext({
          sections: [{ name: 'Tier 1', fields: { resourceSet: RESOURCE_SET, role: 'cr0HELPDESK' } }],
        }),
      ),
    )

    expect(result.checks).toHaveLength(2)
    expect(result.healthy).toBe(true)
  })

  it('is healthy with just the org probe when the canvas declares no bindings', async () => {
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
