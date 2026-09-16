// =============================================================================
// trusted-origins — rollback, driven against the fake Okta org.
//
// Undoing a trust grant has to actually remove it: an origin this deploy created
// is deleted outright (unlike a network zone, no deactivate step is needed), and
// an origin it rewrote gets its captured prior body and lifecycle state back.
// =============================================================================

import rollback from '../rollback'
import type { TrustedOriginRollbackEntry } from '../deploy'
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
  name: 'Corp SPA',
  origin: 'https://old.example.com',
  scopes: [{ type: 'CORS' }],
}

function created(overrides: Partial<TrustedOriginRollbackEntry> = {}): TrustedOriginRollbackEntry {
  return { name: 'Corp SPA', existed: false, id: 'tosNEW', ...overrides }
}

function updated(overrides: Partial<TrustedOriginRollbackEntry> = {}): TrustedOriginRollbackEntry {
  return {
    name: 'Corp SPA',
    existed: true,
    id: 'tosLIVE',
    priorStatus: 'ACTIVE',
    prior: { ...PRIOR_BODY },
    ...overrides,
  }
}

describe('trusted-origins rollback', () => {
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

  it('deletes an origin this deploy created, with no deactivate step', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/trustedOrigins/tosNEW')
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
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
    expect(result.message).toMatch(/Failed to delete trusted origin/)
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

  it('restores the captured prior body of an origin this deploy updated', async () => {
    await withFetch([ok({}), ok({ id: 'tosLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/trustedOrigins/tosLIVE')
      expect(restore.json).toEqual(PRIOR_BODY)
      // Nothing is deleted when the origin existed before the deploy.
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('re-applies the prior lifecycle state after restoring the body', async () => {
    await withFetch(
      [
        ok({}), // PUT — body restored
        ok({ id: 'tosLIVE', status: 'ACTIVE' }), // GET — live is ACTIVE now
        ok({}), // POST .../lifecycle/deactivate
      ],
      async (calls) => {
        const result = await rollback(
          rollbackContext({ previousState: [updated({ priorStatus: 'INACTIVE' })] }),
        )

        expect(result.success).toBe(true)
        expect(writeCalls(calls)[1].path).toBe('/trustedOrigins/tosLIVE/lifecycle/deactivate')
      },
    )
  })

  it('leaves the lifecycle alone when the prior status already matches', async () => {
    await withFetch([ok({}), ok({ id: 'tosLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('leaves an updated entry alone when no prior body was captured', async () => {
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
    expect(result.message).toMatch(/Failed to restore trusted origin/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the restored origin cannot be re-read', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch trusted origin tosLIVE/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ id: 'tosTWO', name: 'Partner SPA' })],
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
