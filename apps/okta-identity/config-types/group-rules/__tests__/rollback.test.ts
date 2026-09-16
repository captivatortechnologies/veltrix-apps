// =============================================================================
// group-rules — rollback, driven against the fake Okta org.
//
// Each deploy branch needs a different undo: a created rule is deleted, an
// in-place update is restored by PUT (which needs the rule INACTIVE first), and a
// rebuild — where deploy had to delete and recreate because `actions` is
// immutable — is undone by deleting the recreation and POSTing the captured
// original back. Reverting in the wrong order, or restoring the wrong status,
// leaves users assigned to groups they should not be in.
// =============================================================================

import rollback from '../rollback'
import type { GroupRuleRollbackEntry } from '../deploy'
import { OKTA_EXPRESSION_TYPE } from '../validate'
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

const PRIOR_RULE = {
  id: '0prLIVE',
  type: 'group_rule',
  status: 'ACTIVE',
  name: 'Engineering auto-assign',
  conditions: { expression: { value: 'user.department=="Engineering"', type: OKTA_EXPRESSION_TYPE } },
  actions: { assignUserToGroups: { groupIds: ['00gENG'] } },
}

const PRIOR_BODY = {
  type: 'group_rule',
  name: 'Engineering auto-assign',
  conditions: { expression: { value: 'user.department=="Engineering"', type: OKTA_EXPRESSION_TYPE } },
  actions: { assignUserToGroups: { groupIds: ['00gENG'] } },
}

function created(overrides: Partial<GroupRuleRollbackEntry> = {}): GroupRuleRollbackEntry {
  return { name: 'Engineering auto-assign', action: 'created', liveId: '0prNEW', ...overrides }
}

function updated(overrides: Partial<GroupRuleRollbackEntry> = {}): GroupRuleRollbackEntry {
  return {
    name: 'Engineering auto-assign',
    action: 'updated',
    liveId: '0prLIVE',
    prior: PRIOR_RULE,
    ...overrides,
  }
}

function rebuilt(overrides: Partial<GroupRuleRollbackEntry> = {}): GroupRuleRollbackEntry {
  return {
    name: 'Engineering auto-assign',
    action: 'rebuilt',
    liveId: '0prREBUILT',
    prior: PRIOR_RULE,
    ...overrides,
  }
}

describe('group-rules rollback', () => {
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

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    const result = await withFetch([ok({}), ok({})], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('deactivates before deleting a rule this deploy created', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/groups/rules/0prNEW/lifecycle/deactivate')
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/groups/rules/0prNEW')
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound(), notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ liveId: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores an updated rule in place: deactivate, PUT the prior body, reactivate', async () => {
    await withFetch([ok({}), ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(3)
      expect(writes[0].path).toBe('/groups/rules/0prLIVE/lifecycle/deactivate')
      expect(writes[1].method).toBe('PUT')
      expect(writes[1].path).toBe('/groups/rules/0prLIVE')
      expect(writes[1].json).toEqual(PRIOR_BODY)
      expect(writes[2].path).toBe('/groups/rules/0prLIVE/lifecycle/activate')
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('leaves a rule that was INACTIVE before the deploy inactive', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ prior: { ...PRIOR_RULE, status: 'INACTIVE' } })] }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/activate'))).toBe(false)
    })
  })

  it('tolerates a 400 on the pre-restore deactivate — the rule was already inactive', async () => {
    await withFetch([apiError('Rule is not active', 400), ok({}), ok({})], async () => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))
      expect(result.success).toBe(true)
    })
  })

  it('surfaces an unexpected failure on the pre-restore deactivate', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/before restore/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('skips an updated entry with no captured prior body', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated({ prior: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('undoes a rebuild by deleting the recreation and POSTing the original back', async () => {
    await withFetch([ok({}), ok({}), ok({ id: '0prRESTORED' }), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [rebuilt()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(4)
      expect(writes[0].path).toBe('/groups/rules/0prREBUILT/lifecycle/deactivate')
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/groups/rules/0prREBUILT')
      expect(writes[2].method).toBe('POST')
      expect(writes[2].path).toBe('/groups/rules')
      expect(writes[2].json).toEqual(PRIOR_BODY)
      // The recreated rule gets a NEW id, so the activation must target that one.
      expect(writes[3].path).toBe('/groups/rules/0prRESTORED/lifecycle/activate')
    })
  })

  it('still recreates the original when the rebuild left no live id behind', async () => {
    await withFetch([ok({ id: '0prRESTORED' }), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [rebuilt({ liveId: undefined })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/groups/rules')
    })
  })

  it('does not attempt an activation when the recreate returns no id', async () => {
    await withFetch([ok({}), ok({}), ok({ name: 'Engineering auto-assign' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [rebuilt()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/activate'))).toBe(false)
    })
  })

  it('returns a FAILED result rather than throwing when the recreate is rejected', async () => {
    const result = await withFetch([ok({}), ok({}), apiError('Api validation failed', 400)], async () =>
      rollback(rollbackContext({ previousState: [rebuilt()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to recreate prior group rule/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reverts in reverse order so later changes are undone first', async () => {
    await withFetch([ok({}), ok({}), ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [
            created({ name: 'First', liveId: '0prFIRST' }),
            created({ name: 'Second', liveId: '0prSECOND' }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
      expect(deletes[0].path).toBe('/groups/rules/0prSECOND')
      expect(deletes[1].path).toBe('/groups/rules/0prFIRST')
    })
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({}), ok({}), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [
              created({ name: 'First', liveId: '0prFIRST' }),
              created({ name: 'Second', liveId: '0prSECOND' }),
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('warns that a rebuilt rule comes back with a new id', async () => {
    const result = await withFetch([ok({}), ok({}), ok({ id: '0prRESTORED' }), ok({})], async () =>
      rollback(rollbackContext({ previousState: [rebuilt()] })),
    )

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/recreated with new ids/)
  })
})
