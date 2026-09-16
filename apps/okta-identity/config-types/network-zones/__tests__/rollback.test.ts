// =============================================================================
// network-zones — rollback, driven against the fake Okta org.
//
// Undoing a trust-boundary change has an Okta-specific trap: an ACTIVE zone
// cannot be deleted, so a zone this deploy created must be DEACTIVATED first.
// A zone it rewrote gets its captured prior definition PUT back and its prior
// lifecycle state restored — and nothing else is touched.
// =============================================================================

import rollback from '../rollback'
import type { ZoneRollbackEntry } from '../deploy'
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

const PRIOR_DEFINITION = {
  name: 'Corp egress',
  type: 'IP',
  gateways: [{ type: 'CIDR', value: '198.51.100.0/24' }],
}

function created(overrides: Partial<ZoneRollbackEntry> = {}): ZoneRollbackEntry {
  return { name: 'Corp egress', existed: false, id: 'nzoNEW', ...overrides }
}

function updated(overrides: Partial<ZoneRollbackEntry> = {}): ZoneRollbackEntry {
  return {
    name: 'Corp egress',
    existed: true,
    id: 'nzoLIVE',
    priorStatus: 'ACTIVE',
    prior: { ...PRIOR_DEFINITION },
    ...overrides,
  }
}

describe('network-zones rollback', () => {
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

  it('deactivates a created zone BEFORE deleting it — Okta will not delete an active zone', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/zones/nzoNEW/lifecycle/deactivate')
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/zones/nzoNEW')
    })
  })

  it('carries on when the zone was already inactive or already gone', async () => {
    for (const first of [notFound(), apiError('Zone is already INACTIVE', 400)]) {
      await withFetch([first, ok({})], async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [created()] }))
        expect(result.success).toBe(true)
        expect(writeCalls(calls)[1].method).toBe('DELETE')
      })
    }
  })

  it('fails on a deactivate error that is neither 404 nor 400', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate zone/)
    expect(result.message).toMatch(/before delete/)
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([ok({}), notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('tells the operator to remove the policy reference when the delete is refused', async () => {
    const result = await withFetch(
      [ok({}), apiError('Zone is used by a policy rule', 400)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Zone is used by a policy rule/)
    expect(result.message).toMatch(/referenced by a policy or policy rule/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior definition of a zone this deploy updated', async () => {
    await withFetch([ok({}), ok({ id: 'nzoLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/zones/nzoLIVE')
      expect(restore.json).toEqual(PRIOR_DEFINITION)
      // Nothing is deleted when the zone existed before the deploy.
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('re-applies the prior lifecycle state after restoring the definition', async () => {
    await withFetch(
      [
        ok({}), // PUT — definition restored
        ok({ id: 'nzoLIVE', status: 'ACTIVE' }), // GET — live is ACTIVE now
        ok({}), // POST .../lifecycle/deactivate
      ],
      async (calls) => {
        const result = await rollback(
          rollbackContext({ previousState: [updated({ priorStatus: 'INACTIVE' })] }),
        )

        expect(result.success).toBe(true)
        expect(writeCalls(calls)[1].path).toBe('/zones/nzoLIVE/lifecycle/deactivate')
      },
    )
  })

  it('leaves the lifecycle alone when the prior status already matches', async () => {
    await withFetch([ok({}), ok({ id: 'nzoLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('leaves an updated entry alone when no prior definition was captured', async () => {
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
    expect(result.message).toMatch(/Failed to restore zone/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the restored zone cannot be re-read', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch zone nzoLIVE/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({}), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [created(), created({ id: 'nzoTWO', name: 'Branch egress' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('never puts the SSWS token in its success message', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )
    expect(result.success).toBe(true)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
