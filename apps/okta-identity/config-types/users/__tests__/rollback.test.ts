// =============================================================================
// users — rollback, driven against the fake Okta org.
//
// Rollback is the safety net for a deploy that went wrong on live accounts, so
// the guarantee that matters is that it NEVER deletes: a user this deploy
// created is deprovisioned, a user it updated is restored to the captured prior
// profile and lifecycle state, and anything else is left alone.
// =============================================================================

import rollback from '../rollback'
import type { UserRollbackEntry } from '../deploy'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  leaksToken,
  notFound,
  ok,
  rollbackContext,
  withFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeOkta'

const PRIOR_PROFILE = {
  login: 'breakglass@example.com',
  email: 'original@example.com',
  firstName: 'Break',
  lastName: 'Glass',
  title: 'Original title',
}

function created(overrides: Partial<UserRollbackEntry> = {}): UserRollbackEntry {
  return { login: 'breakglass@example.com', existed: false, id: '00uNEW', ...overrides }
}

function updated(status = 'ACTIVE', overrides: Partial<UserRollbackEntry> = {}): UserRollbackEntry {
  return {
    login: 'breakglass@example.com',
    existed: true,
    id: '00uLIVE',
    prior: { profile: { ...PRIOR_PROFILE }, status },
    ...overrides,
  }
}

describe('users rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created()] }, { credential: null }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created()] }, { credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports there is nothing to roll back rather than guessing', async () => {
    for (const data of [undefined, {}, { previousState: [] }, { previousState: undefined }]) {
      await withFetch([], async (calls) => {
        const result = await rollback(rollbackContext(data))
        expect(result.success).toBe(false)
        expect(result.message).toBe('No previous state available for rollback')
        expect(calls).toHaveLength(0)
      })
    }
  })

  it('deprovisions a user this deploy created — and never deletes it', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/users/00uNEW/lifecycle/deactivate')
    })
  })

  it('treats a 404 on the deactivate as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created({ id: undefined })] }),
      )
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior profile of a user this deploy updated', async () => {
    await withFetch([ok({}), ok({ id: '00uLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('ACTIVE')] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.path).toBe('/users/00uLIVE')
      expect(restore.json.profile).toEqual(PRIOR_PROFILE)
    })
  })

  it('re-applies the prior lifecycle state after restoring the profile', async () => {
    await withFetch(
      [
        ok({}), // POST /users/00uLIVE — profile restored
        ok({ id: '00uLIVE', status: 'ACTIVE' }), // GET /users/00uLIVE — live now ACTIVE
        ok({}), // POST .../lifecycle/suspend
      ],
      async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [updated('SUSPENDED')] }))

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.path === '/users/00uLIVE/lifecycle/suspend')).toBe(true)
      },
    )
  })

  it('leaves the lifecycle alone when the prior state cannot be cleanly re-applied', async () => {
    await withFetch([ok({})], async (calls) => {
      // STAGED is a create-only state — re-applying it is impossible, so rollback
      // restores the profile and stops rather than forcing a bogus transition.
      const result = await rollback(rollbackContext({ previousState: [updated('STAGED')] }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [created(), created({ login: 'second@example.com', id: '00uTWO' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('never puts the SSWS token in its success message', async () => {
    const result = await withFetch([ok({})], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )
    expect(result.success).toBe(true)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
