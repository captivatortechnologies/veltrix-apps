// =============================================================================
// policies — rollback, driven against the fake Okta org.
//
// Rollback runs after a policy deploy went wrong, which means it runs while the
// door is in the wrong state. The guarantees that matter: a policy this deploy
// created is removed, a policy it replaced is PUT back to its captured body and
// prior lifecycle status, a live system:true policy is REFUSED rather than
// deleted, and a rollback with no captured state says so instead of guessing.
// =============================================================================

import rollback from '../rollback'
import type { PolicyRollbackEntry } from '../deploy'
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

const PRIOR_POLICY = {
  id: 'pol-1',
  type: 'OKTA_SIGN_ON',
  name: 'Corporate sign-on',
  description: 'Original description',
  status: 'INACTIVE',
  system: false,
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://example.test' } },
  conditions: { people: { groups: { include: ['grp-1'] } } },
}

function created(overrides: Partial<PolicyRollbackEntry> = {}): PolicyRollbackEntry {
  return {
    type: 'OKTA_SIGN_ON',
    name: 'Corporate sign-on',
    existed: false,
    id: 'pol-NEW',
    rules: [],
    ...overrides,
  }
}

function updated(overrides: Partial<PolicyRollbackEntry> = {}): PolicyRollbackEntry {
  return {
    type: 'OKTA_SIGN_ON',
    name: 'Corporate sign-on',
    existed: true,
    id: 'pol-1',
    priorPolicy: { ...PRIOR_POLICY },
    priorStatus: 'INACTIVE',
    rules: [],
    ...overrides,
  }
}

describe('policies rollback', () => {
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

  it('deletes a policy this deploy created, after confirming it is not system-managed', async () => {
    await withFetch([ok({ id: 'pol-NEW', system: false }), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/policies/pol-NEW')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/policies/pol-NEW')
    })
  })

  it('REFUSES to delete a live system-managed policy and says so', async () => {
    await withFetch([ok({ id: 'pol-NEW', system: true })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/system policy — not deleted/)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([ok({ id: 'pol-NEW', system: false }), notFound()], async () => {
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

  it('restores the captured prior body, stripped of server-managed fields', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/policies/pol-1')
      // id/created/lastUpdated/system/_links/status are server-managed — a PUT
      // that echoed them back would be rejected or would fight the lifecycle.
      expect(restore.json).toEqual({
        type: 'OKTA_SIGN_ON',
        name: 'Corporate sign-on',
        description: 'Original description',
        conditions: { people: { groups: { include: ['grp-1'] } } },
      })
    })
  })

  it('re-applies the prior lifecycle status after restoring the body', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[1].path).toBe('/policies/pol-1/lifecycle/deactivate')
    })
  })

  it('re-activates a policy whose prior status was ACTIVE', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      await rollback(
        rollbackContext({
          previousState: [updated({ priorStatus: 'ACTIVE', priorPolicy: { ...PRIOR_POLICY, status: 'ACTIVE' } })],
        }),
      )

      expect(writeCalls(calls)[1].path).toBe('/policies/pol-1/lifecycle/activate')
    })
  })

  it('leaves the lifecycle alone when no prior status was captured', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ priorStatus: undefined })] }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('tolerates a 404 while restoring the prior status', async () => {
    await withFetch([ok({}), notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))
      expect(result.success).toBe(true)
    })
  })

  it('deletes a rule this deploy created and restores one it replaced', async () => {
    await withFetch([ok({}), ok({}), ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [
            updated({
              rules: [
                { id: 'rul-1', name: 'Require MFA', existed: true, prior: { id: 'rul-1', name: 'Require MFA', status: 'ACTIVE', system: false, actions: { signon: { access: 'ALLOW' } } } },
                { id: 'rul-2', name: 'New rule', existed: false },
              ],
            }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      // Policy body first, then rules in REVERSE order, then the lifecycle.
      expect(writes[0].path).toBe('/policies/pol-1')
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/policies/pol-1/rules/rul-2')
      expect(writes[2].method).toBe('PUT')
      expect(writes[2].path).toBe('/policies/pol-1/rules/rul-1')
      expect(writes[2].json).toEqual({
        name: 'Require MFA',
        actions: { signon: { access: 'ALLOW' } },
      })
      expect(writes[3].path).toBe('/policies/pol-1/lifecycle/deactivate')
    })
  })

  it('treats a 404 deleting a created rule as already gone', async () => {
    await withFetch([ok({}), notFound(), ok({})], async () => {
      const result = await rollback(
        rollbackContext({
          previousState: [updated({ rules: [{ id: 'rul-2', name: 'New rule', existed: false }] })],
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  it('undoes policies in reverse order so later changes revert first', async () => {
    await withFetch([ok({ system: false }), ok({}), ok({ system: false }), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created({ id: 'pol-FIRST' }), created({ id: 'pol-SECOND' })],
        }),
      )

      expect(result.success).toBe(true)
      const deletes = calls.filter((c) => c.method === 'DELETE')
      expect(deletes[0].path).toBe('/policies/pol-SECOND')
      expect(deletes[1].path).toBe('/policies/pol-FIRST')
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore policy/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch(
      [ok({ system: false }), apiError('Cannot delete policy in use', 400)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete policy/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({ system: false }), ok({}), ok({ system: false }), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [created({ id: 'pol-FIRST' }), created({ id: 'pol-SECOND' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('never puts the SSWS token in its success message', async () => {
    const result = await withFetch([ok({ system: false }), ok({})], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )
    expect(result.success).toBe(true)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
