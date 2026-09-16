// =============================================================================
// sms-templates — healthCheck, driven against the fake Okta org.
//
// A deleted SMS template means the org silently falls back to Okta's default
// text, or stops matching what support tells people to expect. The check must
// report that as a failed check rather than throwing, and must never print the
// SSWS token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  EMPTY_LIST,
  apiError,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const BODY = 'Your ${org.name} verification code is ${code}'

function template(name: string): CanvasItemInput {
  return { name: `${name} SMS`, fields: { name, type: 'SMS_VERIFY_CODE', template: BODY } }
}

const ACME = { id: 'sms-live', name: 'Acme verify', type: 'SMS_VERIFY_CODE', template: BODY }
const PARTNER = { id: 'sms-two', name: 'Partner verify', type: 'SMS_VERIFY_CODE', template: BODY }

describe('sms-templates healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [template('Acme verify')], credential: null }),
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
      const result = await healthCheck(healthContext({ sections: [template('Acme verify')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any template', async () => {
    await withFetch([ok({ id: 'org1' }), ok([ACME])], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [template('Acme verify')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [template('Acme verify')] }))
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
      healthCheck(healthContext({ sections: [template('Acme verify')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared template and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([ACME, PARTNER]), ok([ACME, PARTNER])],
      async () =>
        healthCheck(healthContext({ sections: [template('Acme verify'), template('Partner verify')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('sms-template:Acme verify')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared template that no longer exists in the org', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok([ACME]), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [template('Acme verify'), template('Partner verify')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'sms-template:Partner verify')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a per-template lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [template('Acme verify')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list SMS templates/)
  })

  it('is healthy with just the org probe when the canvas declares no templates', async () => {
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
