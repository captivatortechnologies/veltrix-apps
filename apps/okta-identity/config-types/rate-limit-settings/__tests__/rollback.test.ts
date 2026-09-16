// =============================================================================
// rate-limit-settings — rollback, driven against the fake Okta org.
//
// There is nothing to create or delete here — the three singletons always exist,
// so rollback is purely "PUT the captured prior body back". The failure that
// matters is a rollback that silently does nothing (no prior captured) or that
// replays a partial body and drops an override the org was relying on.
// =============================================================================

import rollback from '../rollback'
import type { RateLimitRollbackData } from '../deploy'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  leaksToken,
  ok,
  rollbackContext,
  withFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeOkta'

const ADMIN_PATH = '/rate-limit-settings/admin-notifications'
const PER_CLIENT_PATH = '/rate-limit-settings/per-client'
const THRESHOLD_PATH = '/rate-limit-settings/warning-threshold'

const PRIOR: RateLimitRollbackData = {
  priorAdminNotifications: { notificationsEnabled: true },
  priorPerClient: {
    defaultMode: 'ENFORCE',
    useCaseModeOverrides: { LOGIN_PAGE: 'PREVIEW' },
  },
  priorWarningThreshold: { warningThreshold: 60 },
}

describe('rate-limit-settings rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext(PRIOR, { credential: null }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext(PRIOR, { credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext(PRIOR, { hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports there is nothing to roll back rather than guessing', async () => {
    for (const data of [undefined, {}, { priorAdminNotifications: undefined }]) {
      await withFetch([], async (calls) => {
        const result = await rollback(rollbackContext(data))
        expect(result.success).toBe(false)
        expect(result.message).toBe('No previous state available for rollback')
        expect(calls).toHaveLength(0)
      })
    }
  })

  it('replays every captured prior body, in order, as a full replace', async () => {
    await withFetch([ok({}), ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext(PRIOR))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(3)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe(ADMIN_PATH)
      expect(writes[0].json).toEqual({ notificationsEnabled: true })
      expect(writes[1].path).toBe(PER_CLIENT_PATH)
      expect(writes[1].json).toEqual({
        defaultMode: 'ENFORCE',
        useCaseModeOverrides: { LOGIN_PAGE: 'PREVIEW' },
      })
      expect(writes[2].path).toBe(THRESHOLD_PATH)
      expect(writes[2].json).toEqual({ warningThreshold: 60 })
      expect(result.message).toMatch(/admin-notifications, per-client, warning-threshold/)
    })
  })

  it('never reads, creates or deletes — the singletons always exist', async () => {
    await withFetch([ok({}), ok({}), ok({})], async (calls) => {
      await rollback(rollbackContext(PRIOR))

      expect(calls.some((c) => c.method === 'GET')).toBe(false)
      expect(calls.some((c) => c.method === 'POST')).toBe(false)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('restores only the parts that were captured', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ priorPerClient: PRIOR.priorPerClient } as RateLimitRollbackData),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].path).toBe(PER_CLIENT_PATH)
      expect(result.message).toBe('Restored rate-limit settings: per-client')
    })
  })

  it('leaves the warning threshold untouched when the deploy captured none', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          priorAdminNotifications: PRIOR.priorAdminNotifications,
          priorPerClient: PRIOR.priorPerClient,
        } as RateLimitRollbackData),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === THRESHOLD_PATH)).toBe(false)
    })
  })

  it('restores notificationsEnabled false rather than treating it as absent', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          priorAdminNotifications: { notificationsEnabled: false },
        } as RateLimitRollbackData),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({ notificationsEnabled: false })
    })
  })

  it('returns a FAILED result rather than throwing when a restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext(PRIOR)),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore admin-notification settings/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how many parts it managed to restore before failing', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await rollback(rollbackContext(PRIOR))
      // It stops at the failure — the threshold is never attempted.
      expect(calls.some((c) => c.path === THRESHOLD_PATH)).toBe(false)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/restoring 1 part\(s\)/)
    expect(result.message).toMatch(/per-client/)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
