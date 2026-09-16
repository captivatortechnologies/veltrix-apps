// =============================================================================
// brands — rollback, driven against the fake Okta org.
//
// Rollback runs after a deploy that has already changed the org's login page. The
// guarantee that matters is the asymmetry: a brand this deploy CREATED is deleted,
// a brand it UPDATED — which includes the org's default brand — is only ever put
// back, never removed. Deleting the default brand would take sign-in down.
// =============================================================================

import rollback from '../rollback'
import type { BrandRollbackEntry } from '../deploy'
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

const PRIOR_BRAND = {
  name: 'Acme',
  removePoweredByOkta: false,
  customPrivacyPolicyUrl: null,
  agreeToCustomPrivacyPolicy: false,
  locale: 'en',
}

const PRIOR_THEME = {
  primaryColorHex: '#000000',
  primaryColorContrastHex: '#ffffff',
  secondaryColorHex: '#111111',
  secondaryColorContrastHex: '#eeeeee',
}

function created(overrides: Partial<BrandRollbackEntry> = {}): BrandRollbackEntry {
  return { name: 'Acme', existed: false, id: 'brd-new', ...overrides }
}

function updated(overrides: Partial<BrandRollbackEntry> = {}): BrandRollbackEntry {
  return { name: 'Acme', existed: true, id: 'brd-live', priorBrand: { ...PRIOR_BRAND }, ...overrides }
}

describe('brands rollback', () => {
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

  it('deletes a brand this deploy created', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/brands/brd-new')
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('explains that a brand still in use cannot be deleted', async () => {
    const result = await withFetch([apiError('Cannot delete brand in use', 400)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Cannot delete brand in use/)
    expect(result.message).toMatch(/still in use/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores an updated brand in place and never deletes it', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/brands/brd-live')
      expect(restore.json).toEqual(PRIOR_BRAND)
    })
  })

  it('restores the prior theme after the brand body, when a theme was changed', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [updated({ themeId: 'thm-1', priorTheme: { ...PRIOR_THEME } })],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].path).toBe('/brands/brd-live')
      expect(writes[1].path).toBe('/brands/brd-live/themes/thm-1')
      expect(writes[1].json).toEqual(PRIOR_THEME)
    })
  })

  it('leaves the theme alone when the deploy never touched it', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/themes'))).toBe(false)
    })
  })

  it('does nothing for an updated entry with no captured prior body', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ priorBrand: undefined })] }),
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
    expect(result.message).toMatch(/Failed to restore brand "Acme"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the theme restore is rejected', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [updated({ themeId: 'thm-1', priorTheme: { ...PRIOR_THEME } })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore theme for brand "Acme"/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ name: 'Partner', id: 'brd-two' })],
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
