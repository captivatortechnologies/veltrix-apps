// =============================================================================
// resource-set-bindings — rollback, driven against the fake Okta org.
//
// This is the un-grant. A binding the deploy created is deleted outright; a
// binding it widened has its membership put back exactly as captured — and the
// add-before-remove order still applies, because Okta deletes a binding the
// moment it loses its last member.
// =============================================================================

import rollback from '../rollback'
import type { BindingRollbackEntry } from '../deploy'
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

const RESOURCE_SET = 'Helpdesk scope'
const ROLE = 'cr0HELPDESK'
const BINDING_PATH = '/iam/resource-sets/Helpdesk%20scope/bindings/cr0HELPDESK'
const MEMBERS_PATH = `${BINDING_PATH}/members`

const GROUP = `${API_BASE}/groups/00g1`
const USER = `${API_BASE}/users/00u1`

function created(overrides: Partial<BindingRollbackEntry> = {}): BindingRollbackEntry {
  return { resourceSet: RESOURCE_SET, role: ROLE, existed: false, ...overrides }
}

function updated(overrides: Partial<BindingRollbackEntry> = {}): BindingRollbackEntry {
  return { resourceSet: RESOURCE_SET, role: ROLE, existed: true, priorMembers: [GROUP], ...overrides }
}

function member(id: string, href: string) {
  return { id, _links: { self: { href } } }
}

function membersList(items: unknown[]) {
  return ok({ members: items })
}

describe('resource-set-bindings rollback', () => {
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

  it('deletes a binding this deploy created, authenticating with the SSWS token', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe(BINDING_PATH)
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete binding/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('revokes a member the deploy added and re-grants one it removed', async () => {
    await withFetch(
      [
        membersList([member('mem-2', USER)]), // what deploy left live
        ok({}), // PATCH — re-grant the prior member
        ok({}), // DELETE — revoke the one deploy added
      ],
      async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [updated()] }))

        expect(result.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(2)
        expect(writes[0].method).toBe('PATCH')
        expect(writes[0].path).toBe(MEMBERS_PATH)
        expect(writes[0].json).toEqual({ additions: [GROUP] })
        expect(writes[1].method).toBe('DELETE')
        expect(writes[1].path).toBe(`${MEMBERS_PATH}/mem-2`)
      },
    )
  })

  it('leaves an untouched membership alone', async () => {
    await withFetch([membersList([member('mem-1', GROUP)])], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('strips every member when the binding recorded no prior members', async () => {
    await withFetch(
      [membersList([member('mem-1', GROUP), member('mem-2', USER)]), ok({}), ok({})],
      async (calls) => {
        const result = await rollback(
          rollbackContext({ previousState: [updated({ priorMembers: undefined })] }),
        )

        expect(result.success).toBe(true)
        expect(writeCalls(calls).filter((c) => c.method === 'DELETE')).toHaveLength(2)
        expect(writeCalls(calls).some((c) => c.method === 'PATCH')).toBe(false)
      },
    )
  })

  it('returns a FAILED result rather than throwing when the live membership cannot be read', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list members for binding/)
  })

  it('returns a FAILED result rather than throwing when re-granting is rejected', async () => {
    const result = await withFetch(
      [membersList([member('mem-2', USER)]), apiError('Invalid member', 400)],
      async () => rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to add members to binding/)
  })

  it('undoes the newest change first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created(), created({ role: 'cr0TIER2' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toMatch(/cr0TIER2$/)
      expect(writeCalls(calls)[1].path).toBe(BINDING_PATH)
    })
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({ previousState: [created(), created({ role: 'cr0TIER2' })] }),
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
