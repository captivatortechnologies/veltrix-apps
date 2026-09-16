// =============================================================================
// profile-schemas — healthCheck, driven against the fake Okta org.
//
// A schema that stops resolving means the user type behind it is gone, taking
// every custom attribute — and every mapping and claim downstream of it — with
// it. Because schemas are update-only, a 404 is a real fault, not something the
// next deploy will fix. The check must degrade to a FAILED check rather than
// throwing, and must never print the SSWS token.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  healthContext,
  leaksToken,
  notFound,
  ok,
  unauthorized,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function schema(userTypeId: string, schemaType = 'user'): CanvasItemInput {
  return { name: `${schemaType}:${userTypeId}`, fields: { schemaType, userTypeId } }
}

const LIVE = { id: 'schema-1', definitions: { custom: { properties: {} } } }

describe('profile-schemas healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [schema('default')], credential: null }),
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
      const result = await healthCheck(healthContext({ sections: [schema('default')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before reading any schema', async () => {
    await withFetch([ok({ id: 'org1' }), ok(LIVE)], async (calls) => {
      await healthCheck(healthContext({ sections: [schema('default')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[1].path).toBe('/meta/schemas/user/default')
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [schema('default')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].message).toMatch(/token/i)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [schema('default')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared schema and scores 100 when all resolve', async () => {
    const result = await withFetch([ok({}), ok(LIVE), ok(LIVE)], async () =>
      healthCheck(healthContext({ sections: [schema('default'), schema('default', 'group')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('schema:user:default')
    expect(result.checks[2].name).toBe('schema:group:default')
  })

  it('fails the check for a schema whose user type is gone', async () => {
    const result = await withFetch([ok({}), ok(LIVE), notFound()], async () =>
      healthCheck(healthContext({ sections: [schema('default'), schema('otyGONE')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'schema:user:otyGONE')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist in the Okta org/)
  })

  it('turns a per-schema read error into a failed check instead of throwing', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      healthCheck(healthContext({ sections: [schema('default')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not check a section whose schema type the validator would have rejected', async () => {
    const result = await withFetch([ok({})], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'Bad', fields: { schemaType: 'application' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('is healthy with just the org probe when the canvas declares no schemas', async () => {
    const result = await withFetch([ok({})], async () => healthCheck(healthContext({ sections: [] })))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })
})
