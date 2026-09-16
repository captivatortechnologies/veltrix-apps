// =============================================================================
// authenticators — rollback, driven against the fake Okta org.
//
// The Okta Authenticators API has NO DELETE, so the honest undo of a created
// authenticator is a DEACTIVATE — and the operator has to be told the object is
// still there. An updated authenticator is PUT back to its captured body and
// returned to its prior lifecycle status. Nothing here may ever issue a DELETE.
// =============================================================================

import rollback from '../rollback'
import type { AuthenticatorRollbackEntry } from '../deploy'
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
  key: 'okta_email',
  type: 'email',
  name: 'Email',
  settings: { allowedFor: 'recovery' },
}

function created(overrides: Partial<AuthenticatorRollbackEntry> = {}): AuthenticatorRollbackEntry {
  return {
    identity: 'custom_otp::TOTP',
    key: 'custom_otp',
    name: 'TOTP',
    existed: false,
    id: 'aut-NEW',
    ...overrides,
  }
}

function updated(overrides: Partial<AuthenticatorRollbackEntry> = {}): AuthenticatorRollbackEntry {
  return {
    identity: 'okta_email',
    key: 'okta_email',
    name: 'Email',
    existed: true,
    id: 'aut-1',
    priorStatus: 'INACTIVE',
    prior: { ...PRIOR_BODY },
    ...overrides,
  }
}

describe('authenticators rollback', () => {
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

  it('deactivates — never deletes — an authenticator this deploy created', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/authenticators/aut-NEW/lifecycle/deactivate')
      expect(writes[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('tells the operator the created authenticator still exists', async () => {
    const result = await withFetch([ok({})], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.message).toMatch(/cannot be deleted/)
    expect(result.message).toMatch(/only DEACTIVATED: custom_otp::TOTP/)
  })

  it('treats a 404 or a 400 on the deactivate as already gone or already inactive', async () => {
    for (const response of [notFound(), apiError('Authenticator is already inactive', 400)]) {
      await withFetch([response], async () => {
        const result = await rollback(rollbackContext({ previousState: [created()] }))
        expect(result.success).toBe(true)
      })
    }
  })

  it('leaves okta_password alone even if it somehow appears as created', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created({ identity: 'okta_password', key: 'okta_password', id: 'aut-pw' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior body of an authenticator this deploy updated', async () => {
    await withFetch(
      [ok({}), ok({ id: 'aut-1', key: 'okta_email', status: 'ACTIVE' }), ok({})],
      async (calls) => {
        const result = await rollback(rollbackContext({ previousState: [updated()] }))

        expect(result.success).toBe(true)
        const restore = writeCalls(calls)[0]
        expect(restore.method).toBe('PUT')
        expect(restore.path).toBe('/authenticators/aut-1')
        expect(restore.json).toEqual(PRIOR_BODY)
      },
    )
  })

  it('re-reads the live status and returns the authenticator to its prior one', async () => {
    await withFetch(
      [ok({}), ok({ id: 'aut-1', key: 'okta_email', status: 'ACTIVE' }), ok({})],
      async (calls) => {
        await rollback(rollbackContext({ previousState: [updated()] }))

        expect(calls[1].method).toBe('GET')
        expect(calls[1].path).toBe('/authenticators/aut-1')
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(2)
        expect(writes[1].path).toBe('/authenticators/aut-1/lifecycle/deactivate')
      },
    )
  })

  it('leaves the lifecycle alone when the live status already matches the prior one', async () => {
    await withFetch([ok({}), ok({ id: 'aut-1', status: 'INACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('leaves the lifecycle alone when no prior status was captured', async () => {
    await withFetch([ok({}), ok({ id: 'aut-1', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ priorStatus: undefined })] }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('never re-deactivates okta_password while restoring it', async () => {
    await withFetch([ok({}), ok({ id: 'aut-pw', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [
            updated({ identity: 'okta_password', key: 'okta_password', priorStatus: 'INACTIVE' }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
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

  it('undoes authenticators in reverse order so later changes revert first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [
            created({ identity: 'custom_otp::First', id: 'aut-FIRST' }),
            created({ identity: 'custom_otp::Second', id: 'aut-SECOND' }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/authenticators/aut-SECOND/lifecycle/deactivate')
      expect(calls[1].path).toBe('/authenticators/aut-FIRST/lifecycle/deactivate')
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore authenticator "okta_email"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the re-read is rejected', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch authenticator aut-1/)
  })

  it('returns a FAILED result rather than throwing when the deactivate is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate created authenticator/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [
              created({ identity: 'custom_otp::First', id: 'aut-FIRST' }),
              created({ identity: 'custom_otp::Second', id: 'aut-SECOND' }),
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
