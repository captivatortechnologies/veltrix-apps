// =============================================================================
// network-zones — healthCheck, driven against the fake Okta org.
//
// A zone that has been deleted takes every policy rule scoped to it with it —
// which, depending on the rule, either opens or closes the org. This must report
// that as a FAILED check rather than throwing, and never print the SSWS token.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function zone(name: string): CanvasItemInput {
  return {
    name,
    fields: {
      name,
      type: 'IP',
      status: 'ACTIVE',
      configJson: JSON.stringify({ gateways: [{ type: 'CIDR', value: '203.0.113.0/24' }] }),
    },
  }
}

const LIVE_ZONE = { id: 'nzoLIVE', name: 'Corp egress', type: 'IP', status: 'ACTIVE' }

describe('network-zones healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [zone('Corp egress')], credential: null }),
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
      const result = await healthCheck(healthContext({ sections: [zone('Corp egress')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any zone', async () => {
    await withFetch([ok({ id: 'org1' }), ok([LIVE_ZONE])], async (calls) => {
      await healthCheck(healthContext({ sections: [zone('Corp egress')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [zone('Corp egress')] }))
      // The zone checks are skipped once the org probe fails.
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
      healthCheck(healthContext({ sections: [zone('Corp egress')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [zone('Corp egress')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared zone and scores 100 when all are present', async () => {
    const result = await withFetch(
      [
        ok({ id: 'org1' }),
        ok([LIVE_ZONE]),
        ok([{ id: 'nzoTWO', name: 'Branch egress', type: 'IP', status: 'ACTIVE' }]),
      ],
      async () =>
        healthCheck(healthContext({ sections: [zone('Corp egress'), zone('Branch egress')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('zone:Corp egress')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared zone that no longer exists in the org', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok([LIVE_ZONE]), ok([])], async () =>
      healthCheck(healthContext({ sections: [zone('Corp egress'), zone('Deleted egress')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'zone:Deleted egress')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-zone lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403), ok([{ id: 'nzoTWO', name: 'Branch egress' }])],
      async () =>
        healthCheck(healthContext({ sections: [zone('Corp egress'), zone('Branch egress')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    // One broken lookup does not abort the rest.
    expect(result.checks[2].passed).toBe(true)
    expect(result.score).toBe(67)
    expect(leaksToken(result)).toBe(false)
  })

  it('follows the Link header so a zone on a later page still passes its check', async () => {
    const result = await withFetch(
      [
        ok({ id: 'org1' }),
        {
          status: 200,
          body: [{ id: 'nzoOTHER', name: 'Somewhere else' }],
          headers: { link: `<${API_BASE}/zones?after=nzoOTHER>; rel="next"` },
        },
        ok([LIVE_ZONE]),
      ],
      async () => healthCheck(healthContext({ sections: [zone('Corp egress')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
  })

  it('skips a section with no name or no type', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'Half done', fields: { name: 'Corp egress' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.healthy).toBe(true)
  })

  it('is healthy with just the org probe when the canvas declares no zones', async () => {
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
