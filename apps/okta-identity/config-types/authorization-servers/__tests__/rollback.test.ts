// =============================================================================
// authorization-servers — rollback, driven against the fake Okta org.
//
// Rollback is the only handler here that deletes, so the guarantees that matter
// are: a server this deploy CREATED is deactivated before it is deleted (Okta
// refuses to delete an active one), a server it UPDATED is PUT back to exactly
// the captured prior body, and the Okta-provided `default` server is never
// deleted under any circumstances.
// =============================================================================

import rollback from '../rollback'
import type { AuthServerRollbackEntry } from '../deploy'
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
  name: 'Partner API',
  description: 'Old description',
  audiences: ['api://old'],
  issuerMode: 'ORG_URL',
}

function created(overrides: Partial<AuthServerRollbackEntry> = {}): AuthServerRollbackEntry {
  return { name: 'Partner API', existed: false, id: 'ausNEW', ...overrides }
}

function updated(
  priorStatus = 'ACTIVE',
  overrides: Partial<AuthServerRollbackEntry> = {},
): AuthServerRollbackEntry {
  return {
    name: 'Partner API',
    existed: true,
    id: 'aus1a2b3c',
    priorStatus,
    prior: { ...PRIOR_BODY },
    ...overrides,
  }
}

describe('authorization-servers rollback', () => {
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

  it('deactivates a created server BEFORE deleting it — Okta refuses to delete an active one', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/authorizationServers/ausNEW/lifecycle/deactivate')
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/authorizationServers/ausNEW')
    })
  })

  it('treats an already-inactive server (400) and an already-gone one (404) as done', async () => {
    for (const deactivateResponse of [apiError('Already inactive', 400), notFound()]) {
      await withFetch([deactivateResponse, notFound()], async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [created()] }))
        expect(result.success).toBe(true)
        expect(writeCalls(calls)).toHaveLength(2)
      })
    }
  })

  it('refuses outright to delete the Okta-provided default authorization server', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created({ name: 'default', id: 'default' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
      expect(result.message).toMatch(/Okta default server — not deleted/)
      // Skipped, so it is not counted as reverted either.
      expect(result.message).toMatch(/Rolled back 0 authorization server\(s\)/)
    })
  })

  it('matches the protected id case-insensitively', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created({ name: 'Default', id: 'DEFAULT' })] }),
      )
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
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

  it('restores the captured prior body of a server this deploy updated', async () => {
    await withFetch([ok({}), ok({ id: 'aus1a2b3c', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('ACTIVE')] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/authorizationServers/aus1a2b3c')
      expect(restore.json).toEqual(PRIOR_BODY)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('re-applies the prior lifecycle status after restoring the body', async () => {
    await withFetch(
      [ok({}), ok({ id: 'aus1a2b3c', status: 'ACTIVE' }), ok({})],
      async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [updated('INACTIVE')] }))

        expect(result.success).toBe(true)
        expect(
          calls.some((c) => c.path === '/authorizationServers/aus1a2b3c/lifecycle/deactivate'),
        ).toBe(true)
      },
    )
  })

  it('leaves the lifecycle alone when the live status already matches the prior one', async () => {
    await withFetch([ok({}), ok({ id: 'aus1a2b3c', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated('ACTIVE')] }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('does nothing for an updated entry whose prior body was never captured', async () => {
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
    expect(result.message).toMatch(/Failed to restore authorization server "Partner API"/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch(
      [ok({}), apiError('Cannot delete active authorization server', 403)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete authorization server "Partner API"/)
  })

  it('returns a FAILED result when the pre-delete deactivate is rejected for a real reason', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403)],
      async (calls) => {
        const res = await rollback(rollbackContext({ previousState: [created()] }))
        // It must not go on to DELETE after a deactivate it could not perform.
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/before delete/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({}), ok({}), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [created(), created({ name: 'Second API', id: 'ausTWO' })],
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
