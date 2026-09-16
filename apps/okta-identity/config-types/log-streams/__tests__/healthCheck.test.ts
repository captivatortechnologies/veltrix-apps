// =============================================================================
// log-streams — healthCheck, driven against the fake Okta org.
//
// A deleted log stream is the quietest failure in the org: events simply stop
// arriving at the SIEM and nothing in Okta complains. This check is what notices,
// so it must degrade to a FAILED check rather than throwing, and must never print
// the SSWS token or the Splunk HEC token into a check message.
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

const HEC_TOKEN = 'splunk-hec-SUPERSECRET-token'

function stream(name: string): CanvasItemInput {
  return {
    name,
    fields: {
      name,
      type: 'splunk_cloud_logstreaming',
      status: 'ACTIVE',
      settingsJson: JSON.stringify({ host: 'http-inputs-acme.splunkcloud.com', edition: 'aws' }),
      splunkToken: HEC_TOKEN,
    },
  }
}

const live = (name: string): Record<string, unknown> => ({
  id: 'ls1',
  name,
  type: 'splunk_cloud_logstreaming',
  status: 'ACTIVE',
  settings: { host: 'http-inputs-acme.splunkcloud.com', edition: 'aws' },
})

describe('log-streams healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [stream('A')], credential: null }))

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
      const result = await healthCheck(healthContext({ sections: [stream('A')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before listing any stream', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('A')])], async (calls) => {
      await healthCheck(healthContext({ sections: [stream('A')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [stream('A')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/token/i)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [stream('A')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared stream and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('A')]), ok([live('B')])],
      async () => healthCheck(healthContext({ sections: [stream('A'), stream('B')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('log-stream:A')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared stream that no longer exists — the audit trail has ended', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok([live('A')]), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [stream('A'), stream('Gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'log-stream:Gone')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a failed stream listing into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [stream('A')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list log streams/)
    expect(leaksToken(result)).toBe(false)
    expect(JSON.stringify(result).includes(HEC_TOKEN)).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no streams', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async () =>
      healthCheck(healthContext({ sections: [] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('never writes anything — a health check must not change the org', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('A')])], async (calls) => {
      await healthCheck(healthContext({ sections: [stream('A')] }))
      expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
    })
  })
})
