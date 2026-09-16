// =============================================================================
// behavior-rules — rollback, driven against the fake Okta org.
//
// Rollback deletes the behaviors this deploy created and PUTs the ones it
// replaced back to their captured definition and lifecycle status. A rule left
// in the wrong state after a failed deploy is a policy that has quietly stopped
// challenging risky logins, so the restore has to be exact — and a rollback with
// no captured state has to say so rather than guess.
// =============================================================================

import rollback from '../rollback'
import type { BehaviorRollbackEntry } from '../deploy'
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
  name: 'Impossible travel',
  type: 'VELOCITY',
  settings: { velocityKph: 500 },
}

function created(overrides: Partial<BehaviorRollbackEntry> = {}): BehaviorRollbackEntry {
  return { name: 'Impossible travel', existed: false, id: 'beh-NEW', ...overrides }
}

function updated(overrides: Partial<BehaviorRollbackEntry> = {}): BehaviorRollbackEntry {
  return {
    name: 'Impossible travel',
    existed: true,
    id: 'beh-1',
    priorStatus: 'INACTIVE',
    prior: { ...PRIOR_BODY },
    ...overrides,
  }
}

describe('behavior-rules rollback', () => {
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

  it('deletes a behavior this deploy created, with no deactivate-first dance', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe('/behaviors/beh-NEW')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch([apiError('Behavior is in use by a policy', 400)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete behavior "Impossible travel"/)
    expect(result.message).toMatch(/in use by a policy/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior definition of a behavior this deploy updated', async () => {
    await withFetch([ok({}), ok({ id: 'beh-1', status: 'ACTIVE' }), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/behaviors/beh-1')
      expect(restore.json).toEqual(PRIOR_BODY)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('re-reads the live status and returns the behavior to its prior one', async () => {
    await withFetch([ok({}), ok({ id: 'beh-1', status: 'ACTIVE' }), ok({})], async (calls) => {
      await rollback(rollbackContext({ previousState: [updated()] }))

      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe('/behaviors/beh-1')
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[1].path).toBe('/behaviors/beh-1/lifecycle/deactivate')
    })
  })

  it('re-activates a behavior whose prior status was ACTIVE', async () => {
    await withFetch([ok({}), ok({ id: 'beh-1', status: 'INACTIVE' }), ok({})], async (calls) => {
      await rollback(
        rollbackContext({ previousState: [updated({ priorStatus: 'ACTIVE' })] }),
      )

      expect(writeCalls(calls)[1].path).toBe('/behaviors/beh-1/lifecycle/activate')
    })
  })

  it('leaves the lifecycle alone when the live status already matches the prior one', async () => {
    await withFetch([ok({}), ok({ id: 'beh-1', status: 'INACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('leaves the lifecycle alone when no prior status was captured', async () => {
    await withFetch([ok({}), ok({ id: 'beh-1', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ priorStatus: undefined })] }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('does nothing for an updated entry whose prior definition was never captured', async () => {
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
    expect(result.message).toMatch(/Failed to restore behavior "Impossible travel"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the re-read is rejected', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch behavior beh-1/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [
            created({ name: 'First', id: 'beh-FIRST' }),
            created({ name: 'Second', id: 'beh-SECOND' }),
          ],
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
