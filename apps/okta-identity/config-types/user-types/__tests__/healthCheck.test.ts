// =============================================================================
// user-types — healthCheck, driven against the fake Okta org.
//
// A user type that has vanished takes a whole profile schema with it. This check
// lists the org's types ONCE and reuses the result across every per-type check,
// so a failed listing has to land on every check rather than throwing out of the
// handler. The SSWS token must never reach a check message.
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

function userType(name: string): CanvasItemInput {
  return { name: `${name} section`, fields: { name, displayName: `${name} display` } }
}

const live = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  displayName: `${name} display`,
})

describe('user-types healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [userType('contractor')], credential: null }),
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
        healthContext({ sections: [userType('contractor')], credential: emptyCredential() }),
      )
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [userType('contractor')], hostname: '' }),
      )
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before listing any user type', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('oty1', 'contractor')])], async (calls) => {
      await healthCheck(healthContext({ sections: [userType('contractor')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[1].path).toBe('/meta/types/user')
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [userType('contractor')] }))
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
      healthCheck(healthContext({ sections: [userType('contractor')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('lists the org types once and reuses them across every declared type', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('oty1', 'contractor'), live('oty2', 'vendor')])],
      async (calls) => {
        const res = await healthCheck(
          healthContext({ sections: [userType('contractor'), userType('vendor')] }),
        )
        expect(calls.filter((c) => c.path === '/meta/types/user')).toHaveLength(1)
        return res
      },
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('user-type:contractor')
  })

  it('fails the check for a declared type that no longer exists', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('oty1', 'contractor')])],
      async () => healthCheck(healthContext({ sections: [userType('contractor'), userType('gone')] })),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'user-type:gone')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist in the Okta org/)
  })

  it('fails every per-type check when the listing itself is rejected', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [userType('contractor'), userType('vendor')] })),
    )

    expect(result.healthy).toBe(false)
    // The org probe still passed, so 1 of 3.
    expect(result.score).toBe(33)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].message).toMatch(/Failed to list user types/)
    expect(result.checks[2].message).toMatch(/Failed to list user types/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does not list user types at all when the canvas declares none', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(1)
  })

  it('skips a section missing a name or a display name', async () => {
    const result = await withFetch([ok({ id: 'org1' }), EMPTY_LIST], async () =>
      healthCheck(healthContext({ sections: [{ name: 'incomplete', fields: { name: 'contractor' } }] })),
    )

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('writes nothing — a health check must never change the org', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('oty1', 'contractor')])], async (calls) => {
      await healthCheck(healthContext({ sections: [userType('contractor')] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })
})
