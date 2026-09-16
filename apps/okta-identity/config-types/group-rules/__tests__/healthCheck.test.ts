// =============================================================================
// group-rules — healthCheck, driven against the fake Okta org.
//
// A rule that has been deleted out of band stops assigning users to their groups
// and nothing else reports it. The check must degrade to a FAILED check rather
// than throwing, and must never print the SSWS token into a check message.
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

function rule(name: string): CanvasItemInput {
  return {
    name: `${name} section`,
    fields: { name, expression: 'user.department=="Engineering"', groupIds: ['00gENG'], status: 'ACTIVE' },
  }
}

const live = (id: string, name: string, status = 'ACTIVE'): Record<string, unknown> => ({
  id,
  name,
  status,
  conditions: { expression: { value: 'user.department=="Engineering"' } },
  actions: { assignUserToGroups: { groupIds: ['00gENG'] } },
})

describe('group-rules healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [rule('Eng')], credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(result.checks[0].passed).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [rule('Eng')], credential: emptyCredential() }),
      )
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [rule('Eng')], hostname: '' }))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any rule', async () => {
    await withFetch([ok({ companyName: 'Acme' }), ok([live('0pr1', 'Eng')])], async (calls) => {
      const result = await healthCheck(healthContext({ sections: [rule('Eng')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(result.checks[0].message).toMatch(/Acme/)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [rule('Eng')] }))
      // The rule checks are skipped once the org probe fails.
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

  it('treats a 403 the same as a 401 — the token cannot read the org', async () => {
    const result = await withFetch([apiError('Forbidden', 403)], async () =>
      healthCheck(healthContext({ sections: [rule('Eng')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/admin permissions/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [rule('Eng')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared rule and scores 100 when all are present', async () => {
    const result = await withFetch(
      [
        ok({ subdomain: 'dev-12345' }),
        ok([live('0pr1', 'Eng')]),
        ok([live('0pr2', 'Sales')]),
      ],
      async () => healthCheck(healthContext({ sections: [rule('Eng'), rule('Sales')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('rule:Eng')
    expect(result.checks[1].message).toMatch(/status: ACTIVE/)
  })

  it('surfaces a rule that has been quietly deactivated as still present', async () => {
    const result = await withFetch(
      [ok({}), ok([live('0pr1', 'Eng', 'INACTIVE')])],
      async () => healthCheck(healthContext({ sections: [rule('Eng')] })),
    )

    expect(result.healthy).toBe(true)
    expect(result.checks[1].message).toMatch(/status: INACTIVE/)
  })

  it('fails the check for a declared rule that no longer exists in the org', async () => {
    const result = await withFetch(
      [ok({}), ok([live('0pr1', 'Eng')]), EMPTY_LIST],
      async () => healthCheck(healthContext({ sections: [rule('Eng'), rule('Gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'rule:Gone')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist in the org/)
  })

  it('turns a per-rule lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({}), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [rule('Eng')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list group rules/)
    expect(leaksToken(result)).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no rules', async () => {
    const result = await withFetch([ok({})], async () => healthCheck(healthContext({ sections: [] })))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('writes nothing — a health check must never change the org', async () => {
    await withFetch([ok({}), ok([live('0pr1', 'Eng')])], async (calls) => {
      await healthCheck(healthContext({ sections: [rule('Eng')] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })
})
