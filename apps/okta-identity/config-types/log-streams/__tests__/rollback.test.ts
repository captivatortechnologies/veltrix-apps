// =============================================================================
// log-streams — rollback, driven against the fake Okta org.
//
// Rolling back the audit pipe has to be reversible without losing the live HEC
// token: a stream this deploy created is deleted outright (Okta allows deleting
// an active stream, unlike hooks), and a stream it updated is PUT back to its
// captured prior body — which never carried the write-only token — then returned
// to its prior lifecycle status. Entries are undone in reverse order.
// =============================================================================

import rollback from '../rollback'
import type { LogStreamRollbackEntry } from '../deploy'
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
  name: 'Veltrix audit export',
  type: 'aws_eventbridge',
  settings: { accountId: '123456789012', eventSourceName: 'okta-events', region: 'us-east-1' },
}

function created(overrides: Partial<LogStreamRollbackEntry> = {}): LogStreamRollbackEntry {
  return { name: 'Veltrix audit export', existed: false, id: 'lsNEW', ...overrides }
}

function updated(
  priorStatus = 'ACTIVE',
  overrides: Partial<LogStreamRollbackEntry> = {},
): LogStreamRollbackEntry {
  return {
    name: 'Veltrix audit export',
    existed: true,
    id: 'lsLIVE',
    priorStatus,
    prior: { ...PRIOR },
    ...overrides,
  }
}

describe('log-streams rollback', () => {
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

  it('deletes a stream the deploy created', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/logStreams/lsNEW')
    })
  })

  it('treats a 404 on the delete as the stream already being gone', async () => {
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

  it('undoes entries in reverse order so later changes revert first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created({ name: 'First', id: 'lsONE' }), created({ name: 'Second', id: 'lsTWO' })],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes[0].path).toBe('/logStreams/lsTWO')
      expect(writes[1].path).toBe('/logStreams/lsONE')
    })
  })

  it('restores the captured prior body of an updated stream and never deletes it', async () => {
    await withFetch([ok({}), ok({ id: 'lsLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('ACTIVE')] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/logStreams/lsLIVE')
      expect(writes[0].json).toEqual(PRIOR)
      // The prior body never carried the write-only HEC token, so the live token
      // survives the restore untouched.
      expect((writes[0].json.settings as Record<string, unknown>).token).toBeUndefined()
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('re-applies the prior lifecycle status after restoring the body', async () => {
    await withFetch([ok({}), ok({ id: 'lsLIVE', status: 'ACTIVE' }), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('INACTIVE')] }))

      expect(result.success).toBe(true)
      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe('/logStreams/lsLIVE')
      expect(calls.some((c) => c.path === '/logStreams/lsLIVE/lifecycle/deactivate')).toBe(true)
    })
  })

  it('re-activates a stream whose prior status was ACTIVE', async () => {
    await withFetch([ok({}), ok({ id: 'lsLIVE', status: 'INACTIVE' }), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('ACTIVE')] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === '/logStreams/lsLIVE/lifecycle/activate')).toBe(true)
    })
  })

  it('makes no lifecycle call when the stream is already in its prior status', async () => {
    await withFetch([ok({}), ok({ id: 'lsLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('ACTIVE')] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('tolerates the stream having vanished between the restore and the status read', async () => {
    await withFetch([ok({}), notFound(), ok({})], async () => {
      const result = await rollback(rollbackContext({ previousState: [updated('INACTIVE')] }))
      expect(result.success).toBe(true)
    })
  })

  it('skips an updated entry that captured no prior body', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated('ACTIVE', { prior: undefined })] }),
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
    expect(result.message).toMatch(/Failed to restore log stream/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete log stream/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created({ name: 'First', id: 'lsONE' }), created({ name: 'Second', id: 'lsTWO' })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
