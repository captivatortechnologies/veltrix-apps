// =============================================================================
// users — deploy, driven against the fake Okta org.
//
// This config type mutates ACCESS: it creates accounts, rewrites profiles and
// moves lifecycle state. A silent failure here either locks a person out or
// leaves an account live that should have been deprovisioned, so the tests below
// assert the request sequence, the bodies sent, the failure contract and the
// rollback state recorded — not a restated happy path.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  leaksToken,
  notFound,
  ok,
  priorDeployment,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function user(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Break-glass admin',
    fields: {
      login: 'breakglass@example.com',
      email: 'breakglass@example.com',
      firstName: 'Break',
      lastName: 'Glass',
      status: 'ACTIVE',
      ...fields,
    },
  }
}

const LIVE_USER = {
  id: '00uLIVE',
  status: 'ACTIVE',
  profile: {
    login: 'breakglass@example.com',
    email: 'old@example.com',
    firstName: 'Break',
    lastName: 'Glass',
    title: 'Former title',
  },
}

describe('users deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [user()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [user()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [user()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([notFound(), ok({ id: '00uNEW', status: 'STAGED' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [user({ status: 'STAGED' })] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a user that does not exist, STAGED first, then activates it', async () => {
    await withFetch(
      [
        notFound(), // GET /users/{login} — absent
        ok({ id: '00uNEW', status: 'STAGED' }), // POST /users?activate=false
        ok({}), // POST /users/00uNEW/lifecycle/activate
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [user({ sendActivationEmail: true })] }))

        expect(result.success).toBe(true)

        const writes = writeCalls(calls)
        expect(writes).toHaveLength(2)

        // Never created ACTIVE implicitly — the create is explicitly deferred.
        expect(writes[0].path).toBe('/users')
        expect(writes[0].query.activate).toBe('false')
        const profile = writes[0].json.profile as Record<string, unknown>
        expect(profile.login).toBe('breakglass@example.com')
        expect(profile.email).toBe('breakglass@example.com')

        // Lifecycle is reconciled separately, carrying the author's email choice.
        expect(writes[1].path).toBe('/users/00uNEW/lifecycle/activate')
        expect(writes[1].query.sendEmail).toBe('true')
      },
    )
  })

  it('records the created user in rollback state so rollback can deprovision it', async () => {
    const result = await withFetch(
      [notFound(), ok({ id: '00uNEW', status: 'STAGED' }), ok({})],
      async () => deploy(deployContext({ sections: [user()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
      resourceIds: Record<string, string>
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('00uNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['00uNEW'])
    expect(rb.resourceIds).toEqual({ 'item-1': '00uNEW' })
  })

  it('updates a user that already exists and captures its prior profile and status', async () => {
    const result = await withFetch([ok(LIVE_USER), ok(LIVE_USER)], async (calls) => {
      const res = await deploy(deployContext({ sections: [user()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      // A partial profile POST against the resolved id — not a create.
      expect(writes[0].path).toBe('/users/00uLIVE')
      expect(writes[0].query.activate).toBeUndefined()
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('00uLIVE')
    expect(entry.prior).toEqual({ profile: LIVE_USER.profile, status: 'ACTIVE' })
  })

  it('clears an optional attribute the canvas no longer sets rather than leaving it stale', async () => {
    await withFetch([ok(LIVE_USER), ok(LIVE_USER)], async (calls) => {
      await deploy(deployContext({ sections: [user()] }))

      const profile = writeCalls(calls)[0].json.profile as Record<string, unknown>
      // `title` is live on the user but absent from the canvas — sent as null so
      // the partial update converges instead of silently keeping the old value.
      expect(profile.title).toBeNull()
      expect(profile.department).toBeNull()
    })
  })

  it('matches by the id stored on the last successful deploy so a login change renames', async () => {
    await withFetch(
      [ok({ id: '00uSTORED', status: 'ACTIVE', profile: { login: 'old@example.com' } }), ok({})],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [user({ login: 'renamed@example.com', email: 'renamed@example.com' })],
            latestDeployment: priorDeployment({ 'item-1': '00uSTORED' }),
          }),
        )

        expect(result.success).toBe(true)
        // The FIRST lookup is by stored id, not by the new login — otherwise the
        // rename would create a second account for the same person.
        expect(calls[0].path).toBe('/users/00uSTORED')
        expect(calls.some((c) => c.path === '/users/renamed%40example.com')).toBe(false)
        expect(writeCalls(calls)[0].path).toBe('/users/00uSTORED')
      },
    )
  })

  it('falls back to the login when the stored id no longer resolves', async () => {
    await withFetch(
      [notFound(), ok(LIVE_USER), ok(LIVE_USER)],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [user()],
            latestDeployment: priorDeployment({ 'item-1': '00uGONE' }),
          }),
        )

        expect(result.success).toBe(true)
        expect(calls[0].path).toBe('/users/00uGONE')
        expect(calls[1].path).toBe('/users/breakglass%40example.com')
      },
    )
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([notFound(), ok({ id: '00uNEW', status: 'STAGED' }), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [user()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [notFound(), apiError('Api validation failed: login', 400, ['login: already in use'])],
      async () => deploy(deployContext({ sections: [user()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Api validation failed/)
    expect(result.message).toMatch(/already in use/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the lookup itself fails', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [user()] }))
      // A 403 on the read must not be mistaken for "absent" and turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('reports partial progress and keeps rollback state when a later user fails', async () => {
    const result = await withFetch(
      [
        notFound(),
        ok({ id: '00uONE', status: 'STAGED' }),
        ok({}), // first user activated
        notFound(),
        apiError('Insufficient permissions', 403), // second user's create is rejected
      ],
      async () =>
        deploy(
          deployContext({
            sections: [
              user(),
              { ...user({ login: 'second@example.com', email: 'second@example.com' }), name: 'Second' },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    // The first user WAS created — rollback must still be able to undo it.
    expect(rb.createdIds).toEqual(['00uONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('deactivates rather than deletes when the desired status is DEACTIVATED', async () => {
    await withFetch([ok(LIVE_USER), ok(LIVE_USER), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [user({ status: 'DEACTIVATED' })] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.path === '/users/00uLIVE/lifecycle/deactivate')).toBe(true)
    })
  })

  it('warns instead of forcing an impossible transition back to STAGED', async () => {
    const result = await withFetch([ok(LIVE_USER), ok(LIVE_USER)], async (calls) => {
      const res = await deploy(deployContext({ sections: [user({ status: 'STAGED' })] }))
      // No lifecycle call at all — the handler refuses to fabricate a downgrade.
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
      return res
    })

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/warning/)
    expect((result.artifacts as { warnings: string[] }).warnings).toHaveLength(1)
  })

  it('treats a 404 on a lifecycle transition as already-in-that-state', async () => {
    await withFetch(
      [ok({ ...LIVE_USER, status: 'SUSPENDED' }), ok(LIVE_USER), notFound()],
      async () => {
        const result = await deploy(deployContext({ sections: [user({ status: 'ACTIVE' })] }))
        expect(result.success).toBe(true)
      },
    )
  })

  it('never reads or writes a user that is not declared in the canvas', async () => {
    await withFetch([ok(LIVE_USER), ok(LIVE_USER)], async (calls) => {
      await deploy(deployContext({ sections: [user()] }))

      for (const call of calls) {
        expect(
          call.path === '/users/breakglass%40example.com' || call.path.startsWith('/users/00uLIVE'),
        ).toBe(true)
      }
      // In particular it never enumerates the org's whole user directory.
      expect(calls.some((c) => c.path === '/users')).toBe(false)
    })
  })
})
