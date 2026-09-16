// =============================================================================
// custom-admin-roles — healthCheck, driven against the fake Okta org.
//
// This is what tells an operator a privilege bundle has been deleted out from
// under a binding, or that the admin token has been revoked. It must degrade to
// a FAILED check rather than throwing, and must never print the SSWS token.
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

function role(label: string): CanvasItemInput {
  return {
    name: label,
    fields: { label, description: 'Least privilege', permissions: ['okta.users.read'] },
  }
}

function rolesList(roles: unknown[]) {
  return ok({ roles })
}

const LIVE_ROLE = { id: 'cr0LIVE', label: 'Helpdesk Tier 1', description: 'Least privilege' }

describe('custom-admin-roles healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [role('Helpdesk Tier 1')], credential: null }),
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
      const result = await healthCheck(healthContext({ sections: [role('Helpdesk Tier 1')], hostname: '' }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any role', async () => {
    await withFetch([ok({ id: 'org1' }), rolesList([LIVE_ROLE])], async (calls) => {
      await healthCheck(healthContext({ sections: [role('Helpdesk Tier 1')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [role('Helpdesk Tier 1')] }))
      // The role checks are skipped once the org probe fails.
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

  it('treats a 403 on the org probe as a rejected token too', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      healthCheck(healthContext({ sections: [role('Helpdesk Tier 1')] })),
    )

    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/rejected the API token/)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [role('Helpdesk Tier 1')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].passed).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared role and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), rolesList([LIVE_ROLE, { id: 'cr0TWO', label: 'Helpdesk Tier 2' }])],
      async (calls) => {
        const res = await healthCheck(
          healthContext({ sections: [role('Helpdesk Tier 1'), role('Helpdesk Tier 2')] }),
        )
        // The role list is read once for every declared role.
        expect(calls).toHaveLength(2)
        return res
      },
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('role:Helpdesk Tier 1')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared role that no longer exists in the org', async () => {
    const result = await withFetch([ok({ id: 'org1' }), rolesList([LIVE_ROLE])], async () =>
      healthCheck(healthContext({ sections: [role('Helpdesk Tier 1'), role('Deleted Tier')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'role:Deleted Tier')
    expect(missing).toBeDefined()
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist/)
  })

  it('turns a failing role list into a failed check per role instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () =>
        healthCheck(healthContext({ sections: [role('Helpdesk Tier 1'), role('Helpdesk Tier 2')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Insufficient permissions/)
    expect(result.checks[2].passed).toBe(false)
    // Only the org probe passed: 1 of 3.
    expect(result.score).toBe(33)
    expect(leaksToken(result)).toBe(false)
  })

  it('is healthy with just the org probe when the canvas declares no roles', async () => {
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
