// =============================================================================
// threat-insight — healthCheck, driven against the fake Okta org.
//
// Two checks only: the token is still accepted, and the org-wide ThreatInsight
// singleton is still readable. Both must degrade to a FAILED check rather than
// throwing, and neither may print the SSWS token into a check message.
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

function config(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'ThreatInsight',
    fields: { action: 'block', excludeZones: ['nzoCORP'], ...fields },
  }
}

describe('threat-insight healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [config()], credential: null }))

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
      const result = await healthCheck(healthContext({ sections: [config()], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before reading the configuration', async () => {
    await withFetch([ok({ id: 'org1' }), ok({ action: 'block' })], async (calls) => {
      await healthCheck(healthContext({ sections: [config()] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[1].path).toBe('/threats/configuration')
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [config()] }))
      // The configuration read is skipped once the org probe fails.
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
      healthCheck(healthContext({ sections: [config()] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [config()] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('scores 100 with both checks passing and names the live action', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok({ action: 'block', excludeZones: [] })],
      async () => healthCheck(healthContext({ sections: [config()] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(2)
    expect(result.checks[1].name).toBe('threat_insight_readable')
    expect(result.checks[1].passed).toBe(true)
    expect(result.checks[1].message).toMatch(/action=block/)
  })

  it('turns an unreadable configuration into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [config()] })),
    )

    expect(result.healthy).toBe(false)
    // 1 of 2 checks passed.
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to read ThreatInsight configuration/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reads the configuration even when the canvas declares nothing', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok({ action: 'audit' })], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [] }))
      expect(calls).toHaveLength(2)
      return res
    })

    expect(result.healthy).toBe(true)
    expect(result.checks).toHaveLength(2)
  })
})
