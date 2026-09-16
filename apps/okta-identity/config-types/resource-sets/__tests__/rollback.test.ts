// =============================================================================
// resource-sets — rollback, driven against the fake Okta org.
//
// A deploy that widened a scope has to be narrowable again. Rollback deletes the
// sets it created, restores the prior label/description of the ones it rewrote,
// and — the part that actually matters — puts the resource membership back
// exactly as it was, revoking anything the deploy added.
// =============================================================================

import rollback from '../rollback'
import type { ResourceSetRollbackEntry } from '../deploy'
import {
  API_BASE,
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

const ORN_GROUPS = 'orn:okta:directory:00o1:groups'
const ORN_USERS = 'orn:okta:directory:00o1:users'

function created(overrides: Partial<ResourceSetRollbackEntry> = {}): ResourceSetRollbackEntry {
  return { label: 'Helpdesk scope', existed: false, id: 'iamNEW', ...overrides }
}

function updated(overrides: Partial<ResourceSetRollbackEntry> = {}): ResourceSetRollbackEntry {
  return {
    label: 'Helpdesk scope',
    existed: true,
    id: 'iamLIVE',
    prior: { label: 'Helpdesk scope', description: 'Old description' },
    priorResources: [ORN_GROUPS],
    ...overrides,
  }
}

function membership(id: string, orn: string) {
  return { id, orn, _links: { self: { href: `${API_BASE}/iam/resource-sets/iamLIVE/resources/${id}` } } }
}

function membershipsList(items: unknown[]) {
  return ok({ resources: items })
}

describe('resource-sets rollback', () => {
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

  it('deletes a resource set this deploy created, authenticating with the SSWS token', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/iam/resource-sets/iamNEW')
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('tells the operator to remove the binding when Okta refuses to delete a bound set', async () => {
    const result = await withFetch([apiError('Resource set is bound to a role', 400)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Resource set is bound to a role/)
    expect(result.message).toMatch(/remove the binding first/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior label and description of a set this deploy updated', async () => {
    await withFetch([ok({}), membershipsList([membership('mem-1', ORN_GROUPS)])], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/iam/resource-sets/iamLIVE')
      expect(restore.json).toEqual({ label: 'Helpdesk scope', description: 'Old description' })
    })
  })

  it('revokes a resource the deploy added and re-adds one it removed', async () => {
    await withFetch(
      [
        ok({}), // PUT — label/description restored
        membershipsList([membership('mem-2', ORN_USERS)]), // what deploy left live
        ok({}), // PATCH — re-add the prior resource
        ok({}), // DELETE — revoke the one deploy added
      ],
      async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [updated()] }))

        expect(result.success).toBe(true)
        const patches = writeCalls(calls).filter((c) => c.method === 'PATCH')
        expect(patches).toHaveLength(1)
        expect(patches[0].json).toEqual({ additions: [ORN_GROUPS] })

        const removes = writeCalls(calls).filter((c) => c.method === 'DELETE')
        expect(removes).toHaveLength(1)
        expect(removes[0].path).toBe('/iam/resource-sets/iamLIVE/resources/mem-2')
      },
    )
  })

  it('empties the set when it had no resources before the deploy', async () => {
    await withFetch(
      [ok({}), membershipsList([membership('mem-1', ORN_GROUPS), membership('mem-2', ORN_USERS)]), ok({}), ok({})],
      async (calls) => {
        const result = await rollback(
          rollbackContext({ previousState: [updated({ priorResources: undefined })] }),
        )

        expect(result.success).toBe(true)
        expect(writeCalls(calls).filter((c) => c.method === 'DELETE')).toHaveLength(2)
        expect(writeCalls(calls).some((c) => c.method === 'PATCH')).toBe(false)
      },
    )
  })

  it('leaves an updated entry alone when no prior state was captured for it', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated({ prior: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore resource set/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the live membership cannot be read', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list resources for resource set/)
  })

  it('undoes the newest change first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created({ id: 'iamFIRST' }), created({ id: 'iamSECOND', label: 'Tier 2 scope' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/iam/resource-sets/iamSECOND')
      expect(writeCalls(calls)[1].path).toBe('/iam/resource-sets/iamFIRST')
    })
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created({ id: 'iamFIRST' }), created({ id: 'iamSECOND', label: 'Tier 2 scope' })],
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
