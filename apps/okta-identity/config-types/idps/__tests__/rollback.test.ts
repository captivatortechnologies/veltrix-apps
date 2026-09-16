// =============================================================================
// idps — rollback, driven against the fake Okta org.
//
// Rolling an IdP back happens while federated sign-in is already broken, so the
// order matters: Okta refuses to delete an ACTIVE IdP, so a created one must be
// DEACTIVATED first and only then deleted. An updated one is PUT back to its
// captured definition — minus the client secret, which Okta never returns, and
// the operator has to be told that.
// =============================================================================

import rollback from '../rollback'
import type { IdpRollbackEntry } from '../deploy'
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
  name: 'Partner OIDC',
  type: 'OIDC',
  protocol: { type: 'OIDC', credentials: { client: { client_id: 'cid-1' } } },
  policy: { provisioning: { action: 'AUTO' } },
}

function created(overrides: Partial<IdpRollbackEntry> = {}): IdpRollbackEntry {
  return { name: 'Partner OIDC', existed: false, id: 'idp-NEW', ...overrides }
}

function updated(overrides: Partial<IdpRollbackEntry> = {}): IdpRollbackEntry {
  return {
    name: 'Partner OIDC',
    existed: true,
    id: 'idp-1',
    priorStatus: 'INACTIVE',
    prior: { ...PRIOR_BODY },
    ...overrides,
  }
}

describe('idps rollback', () => {
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

  it('DEACTIVATES before deleting an IdP this deploy created — Okta refuses otherwise', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/idps/idp-NEW/lifecycle/deactivate')
      expect(writes[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/idps/idp-NEW')
    })
  })

  it('treats a 404 or a 400 on the deactivate as already gone or already inactive', async () => {
    for (const response of [notFound(), apiError('IdP is already inactive', 400)]) {
      await withFetch([response, ok({})], async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [created()] }))
        expect(result.success).toBe(true)
        expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
      })
    }
  })

  it('treats a 404 on the delete as already deleted', async () => {
    await withFetch([ok({}), notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('explains that a still-referenced IdP cannot be deleted', async () => {
    const result = await withFetch(
      [ok({}), apiError('Cannot delete idp with active routing rules', 400)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete IdP "Partner OIDC"/)
    expect(result.message).toMatch(/routing rule or policy/)
  })

  it('returns a FAILED result rather than throwing when the deactivate is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))
      // Never attempt the delete once the deactivate genuinely failed.
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/before delete/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior definition of an IdP this deploy updated', async () => {
    await withFetch([ok({}), ok({ id: 'idp-1', status: 'ACTIVE' }), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/idps/idp-1')
      expect(restore.json).toEqual(PRIOR_BODY)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('warns that a restored IdP may need its client secret re-entered', async () => {
    const result = await withFetch([ok({}), ok({ id: 'idp-1', status: 'INACTIVE' })], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/client secret re-entered/)
  })

  it('does not warn about the client secret when nothing was restored', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(true)
    expect(String(result.message).includes('client secret')).toBe(false)
  })

  it('re-reads the live status and returns the IdP to its prior one', async () => {
    await withFetch([ok({}), ok({ id: 'idp-1', status: 'ACTIVE' }), ok({})], async (calls) => {
      await rollback(rollbackContext({ previousState: [updated()] }))

      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe('/idps/idp-1')
      const writes = writeCalls(calls)
      expect(writes[1].path).toBe('/idps/idp-1/lifecycle/deactivate')
    })
  })

  it('leaves the lifecycle alone when the live status already matches the prior one', async () => {
    await withFetch([ok({}), ok({ id: 'idp-1', status: 'INACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

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
    expect(result.message).toMatch(/Failed to restore IdP "Partner OIDC"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the re-read is rejected', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch IdP idp-1/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({}), ok({}), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [
              created({ name: 'First', id: 'idp-FIRST' }),
              created({ name: 'Second', id: 'idp-SECOND' }),
            ],
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
