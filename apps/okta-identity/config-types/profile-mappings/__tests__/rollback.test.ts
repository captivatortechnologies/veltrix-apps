// =============================================================================
// profile-mappings — rollback, driven against the fake Okta org.
//
// Rollback here restores the attribute wiring, not an object: the mapping is
// never created or deleted, so every rollback is a MERGE patch that replays the
// captured prior value of each managed property — including a null pair, which
// re-removes a property this deploy added. Unmanaged properties must stay
// untouched, and the work unwinds in reverse.
// =============================================================================

import rollback from '../rollback'
import type { ProfileMappingRollbackEntry } from '../deploy'
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

const PRIOR_PROPS = {
  department: { expression: 'appuser.oldDepartment', pushStatus: 'DONT_PUSH' },
}

function entry(overrides: Partial<ProfileMappingRollbackEntry> = {}): ProfileMappingRollbackEntry {
  return {
    mappingId: 'prm1a2b3c',
    sourceId: '0oaHRAPP',
    targetId: 'otyDEFAULT',
    priorProperties: { ...PRIOR_PROPS },
    ...overrides,
  }
}

describe('profile-mappings rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry()] }, { credential: null }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry()] }, { credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [entry()] }, { hostname: '' }))
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

  it('replays the captured prior properties verbatim against the stored mapping id', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [entry()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/mappings/prm1a2b3c')
      expect(writes[0].json).toEqual({ properties: PRIOR_PROPS })
    })
  })

  it('re-removes a property this deploy added by replaying its null pair', async () => {
    const nullPair = { department: { expression: null, pushStatus: null } }
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry({ priorProperties: nullPair })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({ properties: nullPair })
    })
  })

  it('never creates or deletes the mapping object itself', async () => {
    await withFetch([ok({})], async (calls) => {
      await rollback(rollbackContext({ previousState: [entry()] }))

      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.path === '/mappings')).toBe(false)
    })
  })

  it('unwinds in reverse so later changes are reverted first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [entry({ mappingId: 'prmFIRST' }), entry({ mappingId: 'prmSECOND' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/mappings/prmSECOND')
      expect(calls[1].path).toBe('/mappings/prmFIRST')
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [entry()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore property mappings for source "0oaHRAPP"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a mapping that no longer exists as a failure, not a silent success', async () => {
    const result = await withFetch([notFound()], async () =>
      rollback(rollbackContext({ previousState: [entry()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore property mappings/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [entry({ mappingId: 'prmFIRST' }), entry({ mappingId: 'prmSECOND' })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('never puts the SSWS token in its success message', async () => {
    const result = await withFetch([ok({})], async () =>
      rollback(rollbackContext({ previousState: [entry()] })),
    )
    expect(result.success).toBe(true)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
