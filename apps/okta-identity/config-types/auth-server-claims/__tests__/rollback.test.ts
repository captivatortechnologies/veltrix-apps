// =============================================================================
// auth-server-claims — rollback, driven against the fake Okta org.
//
// Rollback here removes or rewrites what a token says about a person, so the
// guarantees that matter are: a claim this deploy created is deleted (claims
// have no lifecycle, so a plain DELETE is correct), a claim it updated is PUT
// back to exactly the captured prior body, and an entry with no captured state
// is left alone rather than guessed at.
// =============================================================================

import rollback from '../rollback'
import type { ClaimRollbackEntry } from '../deploy'
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

const PRIOR_BODY = {
  name: 'department',
  status: 'INACTIVE',
  claimType: 'IDENTITY',
  valueType: 'EXPRESSION',
  value: 'user.oldDepartment',
  alwaysIncludeInToken: false,
  conditions: { scopes: [] },
}

const CLAIMS_PATH = '/authorizationServers/default/claims'

function created(overrides: Partial<ClaimRollbackEntry> = {}): ClaimRollbackEntry {
  return { authServerId: 'default', name: 'department', existed: false, id: 'oclNEW', ...overrides }
}

function updated(overrides: Partial<ClaimRollbackEntry> = {}): ClaimRollbackEntry {
  return {
    authServerId: 'default',
    name: 'department',
    existed: true,
    id: 'oclLIVE',
    prior: { ...PRIOR_BODY },
    ...overrides,
  }
}

describe('auth-server-claims rollback', () => {
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
      const result = await rollback(
        rollbackContext({ previousState: [created()] }, { hostname: '' }),
      )
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

  it('deletes a claim this deploy created, with no lifecycle dance first', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe(`${CLAIMS_PATH}/oclNEW`)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('treats a claim that is already gone as done', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior body of a claim this deploy updated', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe(`${CLAIMS_PATH}/oclLIVE`)
      expect(restore.json).toEqual(PRIOR_BODY)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('does nothing for an updated entry whose prior body was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated({ prior: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('uses the parent server captured with each entry, not a shared one', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [updated(), updated({ authServerId: 'aus1a2b3c', id: 'oclOTHER' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe(`${CLAIMS_PATH}/oclLIVE`)
      expect(calls[1].path).toBe('/authorizationServers/aus1a2b3c/claims/oclOTHER')
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore claim "default:department"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete claim "default:department"/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ name: 'costCenter', id: 'oclTWO' })],
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
