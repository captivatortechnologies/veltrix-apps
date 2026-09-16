// =============================================================================
// custom-admin-roles — rollback, driven against the fake Okta org.
//
// Rollback is what un-grants privilege after a bad deploy. The guarantees that
// matter: a role this deploy created is deleted, a role it rewrote gets its
// prior label, description AND permission set back — and a permission the
// deploy added is revoked again rather than left standing.
// =============================================================================

import rollback from '../rollback'
import type { RoleRollbackEntry } from '../deploy'
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

function created(overrides: Partial<RoleRollbackEntry> = {}): RoleRollbackEntry {
  return { label: 'Helpdesk Tier 1', existed: false, id: 'cr0NEW', ...overrides }
}

function updated(overrides: Partial<RoleRollbackEntry> = {}): RoleRollbackEntry {
  return {
    label: 'Helpdesk Tier 1',
    existed: true,
    id: 'cr0LIVE',
    prior: { label: 'Helpdesk Tier 1', description: 'Old description' },
    priorPermissions: ['okta.users.read'],
    ...overrides,
  }
}

function permissionsList(labels: string[]) {
  return ok({ permissions: labels.map((label) => ({ label })) })
}

describe('custom-admin-roles rollback', () => {
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

  it('deletes a role this deploy created, authenticating with the SSWS token', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/iam/roles/cr0NEW')
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('tells the operator to remove the bindings when Okta refuses to delete a bound role', async () => {
    const result = await withFetch([apiError('Role is assigned to a principal', 400)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Role is assigned to a principal/)
    expect(result.message).toMatch(/resource-set bindings first/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior label and description of a role this deploy updated', async () => {
    await withFetch([ok({}), permissionsList(['okta.users.read'])], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/iam/roles/cr0LIVE')
      expect(restore.json).toEqual({ label: 'Helpdesk Tier 1', description: 'Old description' })
    })
  })

  it('revokes a permission the deploy added and re-grants one it removed', async () => {
    await withFetch(
      [
        ok({}), // PUT — label/description restored
        permissionsList(['okta.groups.manage']), // what deploy left live
        ok({}), // POST — re-grant the prior permission
        ok({}), // DELETE — revoke the one deploy added
      ],
      async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [updated()] }))

        expect(result.success).toBe(true)
        const adds = writeCalls(calls).filter((c) => c.method === 'POST')
        expect(adds).toHaveLength(1)
        expect(adds[0].path).toBe('/iam/roles/cr0LIVE/permissions/okta.users.read')

        const removes = writeCalls(calls).filter((c) => c.method === 'DELETE')
        expect(removes).toHaveLength(1)
        expect(removes[0].path).toBe('/iam/roles/cr0LIVE/permissions/okta.groups.manage')
      },
    )
  })

  it('strips every permission when the role had none before the deploy', async () => {
    await withFetch(
      [ok({}), permissionsList(['okta.users.read', 'okta.groups.manage']), ok({}), ok({})],
      async (calls) => {
        const result = await rollback(
          rollbackContext({ previousState: [updated({ priorPermissions: undefined })] }),
        )

        expect(result.success).toBe(true)
        const removes = writeCalls(calls).filter((c) => c.method === 'DELETE')
        expect(removes).toHaveLength(2)
        expect(writeCalls(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
      },
    )
  })

  it('leaves an updated entry alone when no prior state was captured for it', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ prior: undefined })] }),
      )
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore role/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the prior permissions cannot be read', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list permissions/)
  })

  it('undoes the newest change first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created({ id: 'cr0FIRST' }), created({ id: 'cr0SECOND', label: 'Tier 2' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/iam/roles/cr0SECOND')
      expect(writeCalls(calls)[1].path).toBe('/iam/roles/cr0FIRST')
    })
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created({ id: 'cr0FIRST' }), created({ id: 'cr0SECOND', label: 'Tier 2' })],
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
