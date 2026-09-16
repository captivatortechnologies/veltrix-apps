// =============================================================================
// custom-domains — rollback, driven against the fake Okta org.
//
// Rollback here has two honest limits it must not paper over: a certificate is
// WRITE-ONLY, so a rotated one can never be put back, and Okta has no "clear the
// brand" call, so a domain that had no brand before cannot be un-bound. Both are
// stated in the result rather than silently skipped.
// =============================================================================

import rollback from '../rollback'
import type { CustomDomainRollbackEntry } from '../deploy'
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

function created(overrides: Partial<CustomDomainRollbackEntry> = {}): CustomDomainRollbackEntry {
  return { domain: 'login.acme.test', existed: false, id: 'dom-new', ...overrides }
}

function rebound(overrides: Partial<CustomDomainRollbackEntry> = {}): CustomDomainRollbackEntry {
  return { domain: 'login.acme.test', existed: true, id: 'dom-live', priorBrandId: 'brd-old', ...overrides }
}

describe('custom-domains rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }, { credential: null }))
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

  it('deletes a domain this deploy created', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/domains/dom-new')
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
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

  it('rebinds a domain that already existed back to its prior brand and never deletes it', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [rebound()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/domains/dom-live')
      expect(writes[0].json).toEqual({ brandId: 'brd-old' })
    })
  })

  it('says so rather than pretending when a domain cannot be un-bound', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [rebound({ priorBrandId: undefined })] }),
      )

      expect(result.success).toBe(true)
      // Okta has no "clear the brand" call, so nothing is attempted — and the
      // result says the binding survives rather than implying a clean revert.
      expect(calls).toHaveLength(0)
      expect(result.message).toMatch(/could not be un-bound/)
    })
  })

  it('always states that certificate material could not be restored', async () => {
    const result = await withFetch([ok({})], async () =>
      rollback(rollbackContext({ previousState: [rebound()] })),
    )

    expect(result.message).toMatch(/Certificate material is write-only/)
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch([apiError('Domain is in use', 400)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete custom domain "login\.acme\.test"/)
    expect(result.message).toMatch(/Domain is in use/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the rebind is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [rebound()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore brand for custom domain/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ domain: 'login.partner.test', id: 'dom-two' })],
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
