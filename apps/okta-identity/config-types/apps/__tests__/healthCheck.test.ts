// =============================================================================
// apps — healthCheck, driven against the fake Okta org.
//
// The check re-runs the same identity resolution deploy uses, so it catches both
// the app that has vanished and the duplicate label that would make the NEXT
// deploy ambiguous. Both must land as a failed check, never as a thrown crash.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  EMPTY_LIST,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function app(label: string, signOnMode = 'SAML_2_0'): CanvasItemInput {
  return { name: `${label} section`, fields: { label, signOnMode, status: 'ACTIVE' } }
}

const live = (id: string, label: string, signOnMode = 'SAML_2_0'): Record<string, unknown> => ({
  id,
  label,
  signOnMode,
  status: 'ACTIVE',
})

describe('apps healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [app('Salesforce')], credential: null }),
      )

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [app('Salesforce')], credential: emptyCredential() }),
      )
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [app('Salesforce')], hostname: '' }))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before resolving any app', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('0oa1', 'Salesforce')])], async (calls) => {
      await healthCheck(healthContext({ sections: [app('Salesforce')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[1].query.q).toBe('Salesforce')
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [app('Salesforce')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].message).toMatch(/SSWS/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [app('Salesforce')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared app and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('0oa1', 'Salesforce')]), ok([live('0oa2', 'Workday')])],
      async () => healthCheck(healthContext({ sections: [app('Salesforce'), app('Workday')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('app:Salesforce (SAML_2_0)')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared app that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('0oa1', 'Salesforce')]), EMPTY_LIST],
      async () => healthCheck(healthContext({ sections: [app('Salesforce'), app('Gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'app:Gone (SAML_2_0)')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist in the Okta org/)
  })

  it('fails the check when the label has become ambiguous in the org', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('0oa1', 'Salesforce'), live('0oaTWIN', 'Salesforce')])],
      async () => healthCheck(healthContext({ sections: [app('Salesforce')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Ambiguous match/)
  })

  it('fails the check when the app now carries a different sign-on mode', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('0oa1', 'Salesforce', 'BOOKMARK')])],
      async () => healthCheck(healthContext({ sections: [app('Salesforce')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].message).toMatch(/different sign-on mode/)
  })

  it('turns a per-app lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [app('Salesforce')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list apps while resolving/)
    expect(leaksToken(result)).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no apps', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async () =>
      healthCheck(healthContext({ sections: [] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('writes nothing — a health check must never change the org', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('0oa1', 'Salesforce')])], async (calls) => {
      await healthCheck(healthContext({ sections: [app('Salesforce')] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })
})
