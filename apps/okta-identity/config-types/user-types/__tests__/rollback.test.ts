// =============================================================================
// user-types — rollback, driven against the fake Okta org.
//
// Deleting a user type is the dangerous half: Okta refuses to delete the org's
// default type or one still assigned to users, and a type that existed before the
// deploy must never be deleted at all — it is only PUT back. The default-type
// guard is checked live before every delete, because a mistake there takes out
// the profile schema every user in the org sits on.
// =============================================================================

import rollback from '../rollback'
import type { UserTypeRollbackEntry } from '../deploy'
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

function created(overrides: Partial<UserTypeRollbackEntry> = {}): UserTypeRollbackEntry {
  return { name: 'contractor', existed: false, id: 'otyNEW', ...overrides }
}

function updated(overrides: Partial<UserTypeRollbackEntry> = {}): UserTypeRollbackEntry {
  return {
    name: 'contractor',
    existed: true,
    id: 'otyLIVE',
    prior: { name: 'contractor', displayName: 'Contractor', description: 'External contractors' },
    ...overrides,
  }
}

describe('user-types rollback', () => {
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

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }, { hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
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

  it('checks the live type before deleting one this deploy created', async () => {
    const result = await withFetch([ok({ id: 'otyNEW', default: false }), ok({})], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))

      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/meta/types/user/otyNEW')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/meta/types/user/otyNEW')
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('refuses to delete the org default user type and says so', async () => {
    const result = await withFetch([ok({ id: 'otyNEW', default: true })], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/Skipped: contractor \(default user type — not deleted\)/)
    // A skipped entry is not counted as reverted.
    expect(result.message).toMatch(/Rolled back 0 user type\(s\)/)
  })

  it('still deletes when the live type can no longer be read', async () => {
    await withFetch([notFound(), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].method).toBe('DELETE')
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([ok({ id: 'otyNEW' }), notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('explains the assigned-users case when Okta refuses the delete', async () => {
    const result = await withFetch(
      [ok({ id: 'otyNEW' }), apiError('Cannot delete a user type with users', 403)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete user type "contractor"/)
    expect(result.message).toMatch(/reassign those users to another type first/)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores an updated type in place and never deletes it', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/meta/types/user/otyLIVE')
      expect(writes[0].json).toEqual({
        name: 'contractor',
        displayName: 'Contractor',
        description: 'External contractors',
      })
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('restores an empty prior description as an explicit clear', async () => {
    await withFetch([ok({})], async (calls) => {
      await rollback(
        rollbackContext({
          previousState: [
            updated({ prior: { name: 'contractor', displayName: 'Contractor', description: '' } }),
          ],
        }),
      )

      expect(writeCalls(calls)[0].json.description).toBe('')
    })
  })

  it('leaves an updated type alone when no prior definition was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated({ prior: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('reverts in reverse order so later changes are undone first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [updated(), updated({ name: 'vendor', id: 'otyTWO' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/meta/types/user/otyTWO')
      expect(calls[1].path).toBe('/meta/types/user/otyLIVE')
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore user type "contractor"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [updated(), updated({ name: 'vendor', id: 'otyTWO' })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })
})
