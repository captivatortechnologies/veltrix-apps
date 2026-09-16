// =============================================================================
// auth-server-scopes — rollback, driven against the fake Okta org.
//
// Rollback here removes or rewrites a unit of token authority, so the guarantees
// that matter are: a live system:true scope is REFUSED (never deleted), a scope
// this deploy updated is PUT back to exactly the captured prior body, and the
// work unwinds in reverse order. There is no lifecycle for a scope, so there is
// no status to restore — only the body.
// =============================================================================

import rollback from '../rollback'
import type { ScopeRollbackEntry } from '../deploy'
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
  name: 'partner.read',
  displayName: 'Old display name',
  description: 'Old description',
  consent: 'IMPLICIT',
  default: true,
  metadataPublish: 'ALL_CLIENTS',
  optional: true,
}

const SCOPES_PATH = '/authorizationServers/default/scopes'

function created(overrides: Partial<ScopeRollbackEntry> = {}): ScopeRollbackEntry {
  return { authServerId: 'default', name: 'partner.read', existed: false, id: 'scpNEW', ...overrides }
}

function updated(overrides: Partial<ScopeRollbackEntry> = {}): ScopeRollbackEntry {
  return {
    authServerId: 'default',
    name: 'partner.read',
    existed: true,
    id: 'scpLIVE',
    prior: { ...PRIOR_BODY },
    ...overrides,
  }
}

describe('auth-server-scopes rollback', () => {
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

  it('re-reads the live scope before deleting one this deploy created', async () => {
    await withFetch([ok({ id: 'scpNEW', system: false }), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(`${SCOPES_PATH}/scpNEW`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe(`${SCOPES_PATH}/scpNEW`)
    })
  })

  it('refuses outright to delete a live built-in system scope', async () => {
    await withFetch([ok({ id: 'scpNEW', system: true })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
      expect(result.message).toMatch(/system scope — not deleted/)
      expect(result.message).toMatch(/Rolled back 0 authorization-server scope\(s\)/)
    })
  })

  it('treats a scope that is already gone as done', async () => {
    await withFetch([notFound(), notFound()], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(1)
    })
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior body of a scope this deploy updated', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe(`${SCOPES_PATH}/scpLIVE`)
      expect(restore.json).toEqual(PRIOR_BODY)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('does nothing for an updated entry whose prior body was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ prior: undefined })] }),
      )
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('uses the parent server captured with each entry, not a shared one', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [updated(), updated({ authServerId: 'aus1a2b3c', id: 'scpOTHER' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/authorizationServers/aus1a2b3c/scopes/scpOTHER')
      expect(calls[1].path).toBe(`${SCOPES_PATH}/scpLIVE`)
    })
  })

  it('unwinds in reverse so later changes are reverted first', async () => {
    await withFetch([ok({ system: false }), ok({}), ok({ system: false }), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created({ id: 'scpFIRST' }), created({ name: 'second', id: 'scpSECOND' })],
        }),
      )

      expect(result.success).toBe(true)
      const deletes = calls.filter((c) => c.method === 'DELETE')
      expect(deletes[0].path).toBe(`${SCOPES_PATH}/scpSECOND`)
      expect(deletes[1].path).toBe(`${SCOPES_PATH}/scpFIRST`)
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore scope "default:partner.read"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch(
      [ok({ system: false }), apiError('Insufficient permissions', 403)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete scope "default:partner.read"/)
  })

  it('returns a FAILED result rather than throwing when the pre-delete read is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))
      // It must not go on to DELETE something it could not read.
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch scope scpNEW/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({ system: false }), ok({}), ok({ system: false }), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [created({ id: 'scpFIRST' }), created({ name: 'second', id: 'scpSECOND' })],
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
