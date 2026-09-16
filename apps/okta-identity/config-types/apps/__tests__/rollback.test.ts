// =============================================================================
// apps — rollback, driven against the fake Okta org.
//
// Deleting an application takes sign-on away from everyone assigned to it, so the
// ordering matters twice over: Okta refuses to delete an ACTIVE app, so a created
// app must be DEACTIVATED first; and an app that existed before the deploy is
// only ever PUT back, never removed. The write-only secrets Okta will not return
// cannot be replayed, and the result has to say so.
// =============================================================================

import rollback from '../rollback'
import type { AppRollbackEntry } from '../deploy'
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
  label: 'Salesforce',
  name: 'salesforce_app',
  signOnMode: 'SAML_2_0',
  settings: { signOn: { ssoAcsUrl: 'https://old.example.test' } },
}

function created(overrides: Partial<AppRollbackEntry> = {}): AppRollbackEntry {
  return { label: 'Salesforce', signOnMode: 'SAML_2_0', existed: false, id: '0oaNEW', ...overrides }
}

function updated(overrides: Partial<AppRollbackEntry> = {}): AppRollbackEntry {
  return {
    label: 'Salesforce',
    signOnMode: 'SAML_2_0',
    existed: true,
    id: '0oaLIVE',
    priorStatus: 'ACTIVE',
    prior: PRIOR_BODY,
    ...overrides,
  }
}

describe('apps rollback', () => {
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

  it('deactivates before deleting an app this deploy created', async () => {
    const result = await withFetch([ok({}), ok({})], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))

      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/apps/0oaNEW/lifecycle/deactivate')
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/apps/0oaNEW')
      return res
    })

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/deactivated before deletion/)
    expect(leaksToken(result)).toBe(false)
  })

  it('tolerates a 400 or 404 on the deactivate — the app was inactive or gone', async () => {
    for (const first of [apiError('App is not active', 400), notFound()]) {
      await withFetch([first, ok({})], async () => {
        const result = await rollback(rollbackContext({ previousState: [created()] }))
        expect(result.success).toBe(true)
      })
    }
  })

  it('surfaces an unexpected failure on the deactivate before delete', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/before delete/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([ok({}), notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('explains what to do when Okta refuses to delete a referenced app', async () => {
    const result = await withFetch([ok({}), apiError('App is still referenced', 400)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete app "Salesforce"/)
    expect(result.message).toMatch(/remove those references first/)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores an updated app in place and never deletes it', async () => {
    await withFetch([ok({}), ok({ id: '0oaLIVE', status: 'ACTIVE' })], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/apps/0oaLIVE')
      expect(writes[0].json).toEqual(PRIOR_BODY)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('warns that a restored app may need its secret re-entered', async () => {
    const result = await withFetch([ok({}), ok({ id: '0oaLIVE', status: 'ACTIVE' })], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.message).toMatch(/client secret \/ signing key re-entered/)
  })

  it('does not claim a secret was lost when nothing was restored in place', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(true)
    expect(String(result.message).includes('re-entered')).toBe(false)
  })

  it('returns the app to the lifecycle status it had before the deploy', async () => {
    await withFetch(
      [ok({}), ok({ id: '0oaLIVE', status: 'ACTIVE' }), ok({})],
      async (calls) => {
        const result = await rollback(
          rollbackContext({ previousState: [updated({ priorStatus: 'INACTIVE' })] }),
        )

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.path === '/apps/0oaLIVE/lifecycle/deactivate')).toBe(true)
      },
    )
  })

  it('re-associates the prior access policy without failing the rollback if it cannot', async () => {
    await withFetch(
      [ok({}), ok({ id: '0oaLIVE', status: 'ACTIVE' }), apiError('Not found: Policy', 404)],
      async (calls) => {
        const result = await rollback(
          rollbackContext({ previousState: [updated({ priorAccessPolicyId: 'rst0PRIOR' })] }),
        )

        // A dead prior policy is not a reason to abandon the rest of the rollback.
        expect(result.success).toBe(true)
        expect(calls.some((c) => c.path === '/apps/0oaLIVE/policies/rst0PRIOR')).toBe(true)
      },
    )
  })

  it('leaves an updated app alone when no prior definition was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated({ prior: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Api validation failed', 400)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore app "Salesforce"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch(
      [ok({}), ok({}), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        rollback(
          rollbackContext({
            previousState: [created(), created({ label: 'Workday', id: '0oaTWO' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })
})
