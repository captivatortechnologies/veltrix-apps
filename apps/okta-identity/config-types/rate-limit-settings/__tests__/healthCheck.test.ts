// =============================================================================
// rate-limit-settings — healthCheck, driven against the fake Okta org.
//
// There is no per-item check here: the singletons always exist, so health is
// "can we still read them with this token". A token that lost the org-settings
// admin role has to surface as a failed check, never as a thrown pipeline crash,
// and never with the token printed into the message.
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

const LIVE_ADMIN = { notificationsEnabled: true }
const LIVE_PER_CLIENT = { defaultMode: 'ENFORCE', useCaseModeOverrides: {} }

const limits: CanvasItemInput = {
  name: 'Org rate limits',
  fields: { adminNotificationsEnabled: true, perClientDefaultMode: 'ENFORCE' },
}

describe('rate-limit-settings healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [limits], credential: null }))

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
      const result = await healthCheck(healthContext({ sections: [limits], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before reading any setting', async () => {
    await withFetch([ok({ id: 'org1' }), ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT)], async (calls) => {
      await healthCheck(healthContext({ sections: [limits] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [limits] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/token/i)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [limits] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('scores 100 with three checks when both singletons are readable', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT)],
      async () => healthCheck(healthContext({ sections: [limits] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('admin_notifications_readable')
    expect(result.checks[1].message).toMatch(/enabled=true/)
    expect(result.checks[2].name).toBe('per_client_readable')
    expect(result.checks[2].message).toMatch(/defaultMode=ENFORCE/)
  })

  it('turns an unreadable admin-notifications setting into a failed check, not a throw', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403), ok(LIVE_PER_CLIENT)],
      async () => healthCheck(healthContext({ sections: [limits] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed — and the per-client check still ran.
    expect(result.score).toBe(67)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to read admin-notification settings/)
    expect(result.checks[2].passed).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('turns an unreadable per-client setting into a failed check too', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok(LIVE_ADMIN), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [limits] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(67)
    expect(result.checks[2].passed).toBe(false)
    expect(result.checks[2].message).toMatch(/Failed to read per-client rate-limit settings/)
  })

  it('still reports the settings as readable when the org has no values set', async () => {
    const result = await withFetch([ok({ id: 'org1' }), ok({}), ok({})], async () =>
      healthCheck(healthContext({ sections: [limits] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.checks[1].message).toMatch(/enabled=unknown/)
    expect(result.checks[2].message).toMatch(/defaultMode=unknown/)
  })

  it('checks the org settings even when the canvas declares nothing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT)],
      async () => healthCheck(healthContext({ sections: [] })),
    )

    // The singletons exist whether or not a canvas item describes them.
    expect(result.healthy).toBe(true)
    expect(result.checks).toHaveLength(3)
  })

  it('never writes anything — a health check must not change the org', async () => {
    await withFetch([ok({ id: 'org1' }), ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT)], async (calls) => {
      await healthCheck(healthContext({ sections: [limits] }))
      expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
    })
  })
})
