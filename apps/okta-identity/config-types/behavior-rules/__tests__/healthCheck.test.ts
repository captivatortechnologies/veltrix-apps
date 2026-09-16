// =============================================================================
// behavior-rules — healthCheck, driven against the fake Okta org.
//
// A behavior rule that has been deleted takes the risk signal with it, and the
// sign-on policy that referenced it stops stepping anyone up without saying so.
// This check is the alarm: it must degrade into a FAILED check rather than
// throwing, and must never print the SSWS token into a check message.
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

function behavior(name: string, type = 'VELOCITY'): CanvasItemInput {
  return { name, fields: { type, name, status: 'ACTIVE' } }
}

const LIVE = { id: 'beh-1', name: 'Impossible travel', type: 'VELOCITY', status: 'ACTIVE' }

describe('behavior-rules healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [behavior('Impossible travel')], credential: null }),
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
        healthContext({ sections: [behavior('Impossible travel')], hostname: '' }),
      )

      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any behavior', async () => {
    await withFetch([ok({ companyName: 'Acme' }), ok([LIVE])], async (calls) => {
      await healthCheck(healthContext({ sections: [behavior('Impossible travel')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [behavior('Impossible travel')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a 403 on the org probe as a rejected token too', async () => {
    const result = await withFetch([apiError('You do not have permission', 403)], async () =>
      healthCheck(healthContext({ sections: [behavior('Impossible travel')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/admin with read access/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [behavior('Impossible travel')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared behavior and scores 100 when all are present', async () => {
    const result = await withFetch(
      [
        ok({ companyName: 'Acme' }),
        ok([LIVE]),
        ok([{ id: 'beh-2', name: 'New device', type: 'ANOMALOUS_DEVICE', status: 'ACTIVE' }]),
      ],
      async () =>
        healthCheck(
          healthContext({
            sections: [behavior('Impossible travel'), behavior('New device', 'ANOMALOUS_DEVICE')],
          }),
        ),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('behavior:Impossible travel')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared behavior that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), ok([LIVE]), EMPTY_LIST],
      async () =>
        healthCheck(
          healthContext({
            sections: [behavior('Impossible travel'), behavior('New device', 'ANOMALOUS_DEVICE')],
          }),
        ),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'behavior:New device')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-behavior lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [behavior('Impossible travel')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list behaviors/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not accept a case-variant name as the declared behavior', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), ok([{ ...LIVE, name: 'impossible travel' }])],
      async () => healthCheck(healthContext({ sections: [behavior('Impossible travel')] })),
    )

    expect(result.checks[1].passed).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no behaviors', async () => {
    const result = await withFetch([ok({ companyName: 'Acme' })], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('skips a section with no name or type', async () => {
    const result = await withFetch([ok({ companyName: 'Acme' })], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'Blank', fields: { type: '', name: '' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.healthy).toBe(true)
  })
})
