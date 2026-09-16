// =============================================================================
// email-domains — rollback, driven against the fake Okta org.
//
// Deleting a mail domain that another configuration still points at would break
// delivery for everything bound to it, which is exactly what Okta's 400
// (ErrorEmailDomainInUse) guards. Rollback therefore retries that delete once and
// then surfaces WHY it could not proceed — it never forces the removal and it
// never deletes a domain the deploy merely updated.
// =============================================================================

import rollback from '../rollback'
import type { EmailDomainRollbackEntry } from '../deploy'
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

function created(overrides: Partial<EmailDomainRollbackEntry> = {}): EmailDomainRollbackEntry {
  return { domain: 'mail.acme.test', existed: false, id: 'eml-new', ...overrides }
}

function updated(overrides: Partial<EmailDomainRollbackEntry> = {}): EmailDomainRollbackEntry {
  return {
    domain: 'mail.acme.test',
    existed: true,
    id: 'eml-live',
    prior: { displayName: 'Old Sender', userName: 'old-noreply' },
    ...overrides,
  }
}

describe('email-domains rollback', () => {
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
      expect(writes[0].path).toBe('/email-domains/eml-new')
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('retries once when Okta reports the domain is still in use', async () => {
    await withFetch([apiError('ErrorEmailDomainInUse', 400), ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/email-domains/eml-new')
    })
  })

  it('explains the in-use conflict rather than forcing the delete when the retry fails too', async () => {
    const result = await withFetch(
      [apiError('ErrorEmailDomainInUse', 400), apiError('ErrorEmailDomainInUse', 400)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/still in use by a mail-provider\/brand configuration/)
    expect(result.message).toMatch(/detach it/)
    expect(leaksToken(result)).toBe(false)
  })

  it('accepts a 404 on the retry as already gone', async () => {
    await withFetch([apiError('ErrorEmailDomainInUse', 400), notFound()], async () => {
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

  it('restores the captured sender fields of a domain this deploy updated', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/email-domains/eml-live')
      expect(writes[0].json).toEqual({ displayName: 'Old Sender', userName: 'old-noreply' })
    })
  })

  it('does nothing for an updated entry with no captured prior sender fields', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated({ prior: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the delete is rejected outright', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete email domain "mail\.acme\.test"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore email domain/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ domain: 'mail.partner.test', id: 'eml-two' })],
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
