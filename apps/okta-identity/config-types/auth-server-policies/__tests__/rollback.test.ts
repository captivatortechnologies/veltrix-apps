// =============================================================================
// auth-server-policies — rollback, driven against the fake Okta org.
//
// Rollback is the only handler here that deletes, and the object it deletes
// governs who can obtain a token. The guarantees that matter: a live system:true
// policy is REFUSED outright, a policy this deploy updated is PUT back to its
// prior body with every server-managed field stripped, created rules are removed
// and updated rules restored — and the whole thing unwinds in reverse order.
// =============================================================================

import rollback from '../rollback'
import type { AuthServerPolicyRollbackEntry } from '../deploy'
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
  id: '00pLIVE',
  type: 'OAUTH_AUTHORIZATION_POLICY',
  name: 'Partner access',
  description: 'Old description',
  status: 'ACTIVE',
  priority: 1,
  system: false,
  conditions: { clients: { include: ['ALL_CLIENTS'] } },
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://dev-12345.okta.com' } },
}

const POLICIES_PATH = '/authorizationServers/default/policies'

function created(
  overrides: Partial<AuthServerPolicyRollbackEntry> = {},
): AuthServerPolicyRollbackEntry {
  return {
    authServerId: 'default',
    name: 'Partner access',
    existed: false,
    id: '00pNEW',
    rules: [],
    ...overrides,
  }
}

function updated(
  overrides: Partial<AuthServerPolicyRollbackEntry> = {},
): AuthServerPolicyRollbackEntry {
  return {
    authServerId: 'default',
    name: 'Partner access',
    existed: true,
    id: '00pLIVE',
    priorPolicy: { ...PRIOR_POLICY },
    priorStatus: 'ACTIVE',
    rules: [],
    ...overrides,
  }
}

describe('auth-server-policies rollback', () => {
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

  it('checks the live system flag before deleting a policy this deploy created', async () => {
    await withFetch([ok({ id: '00pNEW', system: false }), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(`${POLICIES_PATH}/00pNEW`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe(`${POLICIES_PATH}/00pNEW`)
    })
  })

  it('refuses outright to delete a live system-managed policy', async () => {
    await withFetch([ok({ id: '00pNEW', system: true })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
      expect(result.message).toMatch(/system policy — not deleted/)
      expect(result.message).toMatch(/Rolled back 0 authorization-server policy\(ies\)/)
    })
  })

  it('treats a policy that is already gone (404 on delete) as done', async () => {
    await withFetch([notFound(), notFound()], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(1)
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

  it('restores the prior policy body with every server-managed field stripped', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe(`${POLICIES_PATH}/00pLIVE`)
      expect(restore.json).toEqual({
        type: 'OAUTH_AUTHORIZATION_POLICY',
        name: 'Partner access',
        description: 'Old description',
        priority: 1,
        conditions: { clients: { include: ['ALL_CLIENTS'] } },
      })
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('re-applies the prior lifecycle status through the lifecycle endpoint', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ priorStatus: 'INACTIVE' })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[1].path).toBe(`${POLICIES_PATH}/00pLIVE/lifecycle/deactivate`)
    })
  })

  it('leaves the lifecycle alone when no prior status was captured', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ priorStatus: undefined })] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('deletes a rule this deploy created and restores one it updated', async () => {
    const priorRule = {
      id: '0prSYS',
      name: 'Default Rule',
      type: 'RESOURCE_ACCESS',
      status: 'INACTIVE',
      system: true,
      created: '2025-01-01T00:00:00.000Z',
      _links: {},
      actions: { token: { accessTokenLifetimeMinutes: 30 } },
    }

    await withFetch([ok({}), ok({}), ok({}), ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [
            updated({
              rules: [
                { id: '0prSYS', name: 'Default Rule', existed: true, prior: priorRule, priorStatus: 'INACTIVE' },
                { id: '0prNEW', name: 'Short-lived tokens', existed: false },
              ],
            }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      const rulesPath = `${POLICIES_PATH}/00pLIVE/rules`

      // Rules unwind in reverse: the created one goes first.
      expect(writes[0].path).toBe(`${POLICIES_PATH}/00pLIVE`)
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe(`${rulesPath}/0prNEW`)
      expect(writes[2].method).toBe('PUT')
      expect(writes[2].path).toBe(`${rulesPath}/0prSYS`)
      expect(writes[2].json).toEqual({
        name: 'Default Rule',
        type: 'RESOURCE_ACCESS',
        actions: { token: { accessTokenLifetimeMinutes: 30 } },
      })
      expect(writes[3].path).toBe(`${rulesPath}/0prSYS/lifecycle/deactivate`)
    })
  })

  it('treats a rule that is already gone (404 on delete) as done', async () => {
    await withFetch([ok({}), notFound(), ok({})], async () => {
      const result = await rollback(
        rollbackContext({
          previousState: [
            updated({ rules: [{ id: '0prNEW', name: 'Short-lived tokens', existed: false }] }),
          ],
        }),
      )
      expect(result.success).toBe(true)
    })
  })

  it('unwinds policies in reverse so later changes are reverted first', async () => {
    await withFetch([ok({ system: false }), ok({}), ok({ system: false }), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created({ id: '00pFIRST' }), created({ name: 'Second', id: '00pSECOND' })],
        }),
      )

      expect(result.success).toBe(true)
      const deletes = calls.filter((c) => c.method === 'DELETE')
      expect(deletes[0].path).toBe(`${POLICIES_PATH}/00pSECOND`)
      expect(deletes[1].path).toBe(`${POLICIES_PATH}/00pFIRST`)
    })
  })

  it('returns a FAILED result rather than throwing when the policy restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore authorization-server policy "default:Partner access"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch(
      [ok({ system: false }), apiError('Insufficient permissions', 403)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete authorization-server policy/)
  })

  it('returns a FAILED result when a rule restore is rejected', async () => {
    const result = await withFetch(
      [ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [
              updated({
                rules: [{ id: '0prSYS', name: 'Default Rule', existed: true, prior: { name: 'Default Rule' } }],
              }),
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore rule "Default Rule"/)
  })

  it('returns a FAILED result when restoring a policy status is rejected', async () => {
    const result = await withFetch(
      [ok({}), apiError('Insufficient permissions', 403)],
      async () => rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore status of authorization-server policy/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({ system: false }), ok({}), ok({ system: false }), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [created({ id: '00pFIRST' }), created({ name: 'Second', id: '00pSECOND' })],
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
