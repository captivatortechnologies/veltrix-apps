// =============================================================================
// authenticators — healthCheck, driven against the fake Okta org.
//
// This is the signal that a factor an org depends on has disappeared, or that the
// admin token was revoked. It must degrade into a FAILED check rather than
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

function authenticator(key: string, name = ''): CanvasItemInput {
  return { name: name || key, fields: { key, name, status: 'ACTIVE' } }
}

const LIVE_EMAIL = { id: 'aut-1', key: 'okta_email', name: 'Email', status: 'ACTIVE' }

describe('authenticators healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [authenticator('okta_email')], credential: null }),
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
        healthContext({ sections: [authenticator('okta_email')], hostname: '' }),
      )

      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any authenticator', async () => {
    await withFetch([ok({ companyName: 'Acme' }), ok([LIVE_EMAIL])], async (calls) => {
      await healthCheck(healthContext({ sections: [authenticator('okta_email')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [authenticator('okta_email')] }))
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
      healthCheck(healthContext({ sections: [authenticator('okta_email')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/admin with read access/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [authenticator('okta_email')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared authenticator and reports its live status', async () => {
    const result = await withFetch(
      [
        ok({ companyName: 'Acme' }),
        ok([LIVE_EMAIL]),
        ok([{ id: 'aut-2', key: 'okta_verify', status: 'INACTIVE' }]),
      ],
      async () =>
        healthCheck(
          healthContext({ sections: [authenticator('okta_email'), authenticator('okta_verify')] }),
        ),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('authenticator:okta_email')
    // Present but INACTIVE still passes — presence is what this check asserts.
    expect(result.checks[2].passed).toBe(true)
    expect(result.checks[2].message).toMatch(/status INACTIVE/)
  })

  it('fails the check for a declared authenticator that no longer exists', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), ok([LIVE_EMAIL]), EMPTY_LIST],
      async () =>
        healthCheck(
          healthContext({ sections: [authenticator('okta_email'), authenticator('okta_verify')] }),
        ),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'authenticator:okta_verify')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('checks a multi-instance authenticator by its (key, name) identity', async () => {
    const result = await withFetch(
      [
        ok({ companyName: 'Acme' }),
        ok([{ id: 'aut-a', key: 'custom_app', name: 'Acme Push', status: 'ACTIVE' }]),
      ],
      async () =>
        healthCheck(healthContext({ sections: [authenticator('custom_app', 'Contractor Push')] })),
    )

    expect(result.checks[1].name).toBe('authenticator:custom_app::Contractor Push')
    expect(result.checks[1].passed).toBe(false)
  })

  it('turns a per-authenticator lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ companyName: 'Acme' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [authenticator('okta_email')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list authenticators/)
    expect(leaksToken(result)).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no authenticators', async () => {
    const result = await withFetch([ok({ companyName: 'Acme' })], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('skips a section with no key rather than checking a keyless authenticator', async () => {
    const result = await withFetch([ok({ companyName: 'Acme' })], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [{ name: 'Blank', fields: { key: '' } }] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.healthy).toBe(true)
  })
})
