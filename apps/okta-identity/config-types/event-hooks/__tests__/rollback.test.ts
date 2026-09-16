// =============================================================================
// event-hooks — rollback, driven against the fake Okta org.
//
// Rollback here has a hard ordering constraint Okta imposes: an ACTIVE event
// hook cannot be deleted, so a hook the deploy created must be DEACTIVATED
// first. A hook the deploy updated is PUT back to its captured prior definition
// and returned to its prior lifecycle status — and must never be deleted.
// =============================================================================

import rollback from '../rollback'
import type { EventHookRollbackEntry } from '../deploy'
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

const PRIOR = {
  name: 'Veltrix audit hook',
  events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create'] },
  channel: {
    type: 'HTTP',
    version: '1.0.0',
    config: {
      uri: 'https://original.example.com/okta',
      authScheme: { type: 'HEADER', key: 'Authorization' },
    },
  },
}

function created(overrides: Partial<EventHookRollbackEntry> = {}): EventHookRollbackEntry {
  return { name: 'Veltrix audit hook', existed: false, id: 'ehNEW', ...overrides }
}

function updated(
  priorStatus = 'ACTIVE',
  overrides: Partial<EventHookRollbackEntry> = {},
): EventHookRollbackEntry {
  return {
    name: 'Veltrix audit hook',
    existed: true,
    id: 'ehLIVE',
    priorStatus,
    prior: { ...PRIOR },
    ...overrides,
  }
}

describe('event-hooks rollback', () => {
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

  it('deactivates before deleting a hook the deploy created — Okta refuses to delete an active hook', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/eventHooks/ehNEW/lifecycle/deactivate')
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/eventHooks/ehNEW')
    })
  })

  it('treats a 400 on the deactivate as already inactive and still deletes', async () => {
    await withFetch([apiError('Hook is already inactive', 400), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/eventHooks/ehNEW')).toBe(true)
    })
  })

  it('treats a 404 on either step as the hook already being gone', async () => {
    await withFetch([notFound(), notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('stops rather than deleting when the deactivate fails for a real reason', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior definition of an updated hook and never deletes it', async () => {
    await withFetch([ok({}), ok({ id: 'ehLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('ACTIVE')] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/eventHooks/ehLIVE')
      expect(writes[0].json).toEqual(PRIOR)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('re-applies the prior lifecycle status after restoring the definition', async () => {
    await withFetch(
      [
        ok({}), // PUT — definition restored
        ok({ id: 'ehLIVE', status: 'ACTIVE' }), // GET — live is ACTIVE
        ok({}), // POST .../lifecycle/deactivate
      ],
      async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [updated('INACTIVE')] }))

        expect(result.success).toBe(true)
        expect(calls[1].method).toBe('GET')
        expect(calls[1].path).toBe('/eventHooks/ehLIVE')
        expect(calls.some((c) => c.path === '/eventHooks/ehLIVE/lifecycle/deactivate')).toBe(true)
      },
    )
  })

  it('makes no lifecycle call when the hook is already in its prior status', async () => {
    await withFetch([ok({}), ok({ id: 'ehLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('ACTIVE')] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('skips an updated entry that captured no prior definition', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated('ACTIVE', { prior: undefined })] }),
      )
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('explains the write-only secret limitation when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Insufficient permissions/)
    // The prior definition can never carry the auth secret back — the operator
    // has to be told, not left with a silently unauthenticated hook.
    expect(result.message).toMatch(/write-only secret/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({}), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [created(), created({ name: 'Second hook', id: 'ehTWO' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('tells the operator the restored hooks still need re-verification', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/re-verification/)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
