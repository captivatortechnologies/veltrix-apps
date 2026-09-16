// =============================================================================
// captcha — healthCheck, driven against the fake Okta org.
//
// A missing CAPTCHA instance means the gate in front of sign-in and enrolment is
// simply not there — credential stuffing walks straight in and nothing errors.
// The check must report that as a failed check rather than throwing, and must
// never print the SSWS token or the provider secret into a check message.
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

const SECRET_KEY = 'hcaptcha-SUPERSECRET-provider-secret'

function captcha(): CanvasItemInput {
  return {
    name: 'Sign-in CAPTCHA',
    fields: {
      name: 'Acme hCaptcha',
      type: 'HCAPTCHA',
      siteKey: 'site-key-public',
      secretKey: SECRET_KEY,
      enabledPages: ['SIGN_IN'],
    },
  }
}

const LIVE_INSTANCE = { id: 'cap-live', name: 'Acme hCaptcha', type: 'HCAPTCHA', siteKey: 'site-key-public' }

function leaksSecret(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('SUPERSECRET-provider-secret')
}

describe('captcha healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [captcha()], credential: null }))

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
      const result = await healthCheck(healthContext({ sections: [captcha()], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking the CAPTCHA', async () => {
    await withFetch([ok({ id: 'org1' }), ok([LIVE_INSTANCE]), ok({ enabledPages: ['SIGN_IN'] })], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [captcha()] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(leaksToken(result)).toBe(false)
      expect(leaksSecret(result)).toBe(false)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [captcha()] }))
      // The CAPTCHA checks are skipped once the org probe fails.
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

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [captcha()] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('scores 100 with all three checks when the instance and org settings resolve', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([LIVE_INSTANCE]), ok({ captchaId: 'cap-live', enabledPages: ['SIGN_IN', 'SSPR'] })],
      async () => healthCheck(healthContext({ sections: [captcha()] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('captcha_instance_present')
    expect(result.checks[2].name).toBe('org_captcha_readable')
    expect(result.checks[2].message).toMatch(/enabled pages: SIGN_IN, SSPR/)
  })

  it('fails the instance check when the org has no CAPTCHA at all', async () => {
    const result = await withFetch([ok({ id: 'org1' }), EMPTY_LIST, ok({})], async () =>
      healthCheck(healthContext({ sections: [captcha()] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/No CAPTCHA instance is configured/)
  })

  it('reports "none" rather than crashing when the org enables the CAPTCHA nowhere', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([LIVE_INSTANCE]), ok({ captchaId: null, enabledPages: null })],
      async () => healthCheck(healthContext({ sections: [captcha()] })),
    )

    // A configured-but-disabled gate still reads as a passing check here; the
    // message is what tells the operator it is protecting nothing.
    expect(result.checks[2].passed).toBe(true)
    expect(result.checks[2].message).toMatch(/enabled pages: none/)
  })

  it('turns an instance lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403), ok({})],
      async () => healthCheck(healthContext({ sections: [captcha()] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(67)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list CAPTCHA instances/)
  })

  it('turns an org-settings read error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([LIVE_INSTANCE]), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [captcha()] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(67)
    expect(result.checks[2].passed).toBe(false)
    expect(result.checks[2].message).toMatch(/Failed to read org-wide CAPTCHA settings/)
    expect(leaksToken(result)).toBe(false)
  })

  it('checks the org even when the canvas declares no CAPTCHA — it is an org-level gate', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok([LIVE_INSTANCE]), ok({})], async () =>
      healthCheck(healthContext({ sections: [] })),
    )

    expect(result.checks).toHaveLength(3)
    expect(result.healthy).toBe(true)
  })
})
