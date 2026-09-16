// =============================================================================
// policies — healthCheck, driven against the fake Okta org.
//
// This is what tells an operator that a sign-on policy has been deleted out from
// under them, or that the admin token was revoked. It has to degrade into a
// FAILED check rather than throwing — an exception here surfaces as an opaque
// pipeline crash with no indication of which policy is gone.
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

function policy(name: string, type = 'OKTA_SIGN_ON'): CanvasItemInput {
  return { name, fields: { type, name, status: 'ACTIVE' } }
}

const LIVE = { id: 'pol-1', type: 'OKTA_SIGN_ON', name: 'Corporate sign-on', status: 'ACTIVE' }

describe('policies healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [policy('Corporate sign-on')], credential: null }),
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
        healthContext({ sections: [policy('Corporate sign-on')], hostname: '' }),
      )

      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any policy', async () => {
    await withFetch([ok({ companyName: 'Acme' }), ok([LIVE])], async (calls) => {
      await healthCheck(healthContext({ sections: [policy('Corporate sign-on')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [policy('Corporate sign-on')] }))
      // The policy checks are skipped once the org probe fails.
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/API token/i)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a 403 on the org probe as a rejected token too', async () => {
    const result = await withFetch([apiError('You do not have permission', 403)], async () =>
      healthCheck(healthContext({ sections: [policy('Corporate sign-on')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/admin permissions/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [policy('Corporate sign-on')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared policy and scores 100 when all are present', async () => {
    const result = await withFetch(
      [
        ok({ companyName: 'Acme' }),
        ok([LIVE]),
        ok([{ id: 'pol-2', type: 'PASSWORD', name: 'Strong passwords' }]),
      ],
      async (calls) => {
        const res = await healthCheck(
          healthContext({
            sections: [policy('Corporate sign-on'), policy('Strong passwords', 'PASSWORD')],
          }),
        )
        expect(calls[2].query.type).toBe('PASSWORD')
        return res
      },
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('policy:OKTA_SIGN_ON:Corporate sign-on')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared policy that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), ok([LIVE]), EMPTY_LIST],
      async () =>
        healthCheck(
          healthContext({
            sections: [policy('Corporate sign-on'), policy('Strong passwords', 'PASSWORD')],
          }),
        ),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'policy:PASSWORD:Strong passwords')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-policy lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [policy('Corporate sign-on')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list OKTA_SIGN_ON policies/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not confuse a same-named policy of another type for the declared one', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), ok([{ id: 'pol-x', type: 'OKTA_SIGN_ON', name: 'Other' }])],
      async () => healthCheck(healthContext({ sections: [policy('Corporate sign-on')] })),
    )

    expect(result.checks[1].passed).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no policies', async () => {
    const result = await withFetch([ok({ subdomain: 'dev-12345' })], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('skips a section with no type or name rather than checking a nameless policy', async () => {
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
