// =============================================================================
// profile-mappings — healthCheck, driven against the fake Okta org.
//
// A mapping that stops resolving means the attribute wiring is gone: the app was
// unassigned, the user type deleted, or the ids were wrong all along. Because
// mappings are update-only, a zero or ambiguous resolve is a real fault, not an
// "it will be created next deploy". The check must degrade to a FAILED check
// rather than throwing, and must never print the SSWS token.
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

function mapping(targetId: string, sourceId = '0oaHRAPP'): CanvasItemInput {
  return { name: `${sourceId}->${targetId}`, fields: { sourceId, targetId } }
}

const resolved = (id: string): Record<string, unknown> => ({ id })

describe('profile-mappings healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [mapping('otyDEFAULT')], credential: null }),
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
        healthContext({ sections: [mapping('otyDEFAULT')], hostname: '' }),
      )

      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before resolving any mapping', async () => {
    await withFetch([ok({ id: 'org1' }), ok([resolved('prm1')])], async (calls) => {
      await healthCheck(healthContext({ sections: [mapping('otyDEFAULT')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [mapping('otyDEFAULT')] }))
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
      healthCheck(healthContext({ sections: [mapping('otyDEFAULT')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared mapping and scores 100 when all resolve', async () => {
    const result = await withFetch(
      [ok({}), ok([resolved('prm1')]), ok([resolved('prm2')])],
      async () =>
        healthCheck(
          healthContext({ sections: [mapping('otyDEFAULT'), mapping('otyCONTRACTOR')] }),
        ),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('mapping:0oaHRAPP:otyDEFAULT')
    expect(result.checks[1].message).toMatch(/id prm1/)
  })

  it('fails the check for a mapping that no longer resolves', async () => {
    const result = await withFetch([ok({}), ok([resolved('prm1')]), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [mapping('otyDEFAULT'), mapping('otyGONE')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'mapping:0oaHRAPP:otyGONE')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/No profile mapping exists/)
  })

  it('fails the check when the resolve is ambiguous rather than picking one', async () => {
    const result = await withFetch(
      [ok({}), ok([resolved('prm1'), resolved('prm2')])],
      async () => healthCheck(healthContext({ sections: [mapping('otyDEFAULT')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Ambiguous: 2 profile mappings match/)
  })

  it('turns a per-mapping lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      healthCheck(healthContext({ sections: [mapping('otyDEFAULT')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not check a section the validator would have rejected', async () => {
    const result = await withFetch([ok({})], async (calls) => {
      const res = await healthCheck(
        healthContext({ sections: [{ name: 'Bad', fields: { sourceId: '0oaHRAPP' } }] }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('is healthy with just the org probe when the canvas declares no mappings', async () => {
    const result = await withFetch([ok({})], async () => healthCheck(healthContext({ sections: [] })))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })
})
