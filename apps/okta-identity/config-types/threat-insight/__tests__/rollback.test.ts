// =============================================================================
// threat-insight — rollback, driven against the fake Okta org.
//
// There is nothing to create or delete here: the singleton always exists, so
// rollback is a single full replace with the config captured before the deploy.
// If that capture is missing, rollback must refuse rather than invent a state —
// guessing "none" here would silently switch the org's threat blocking off.
// =============================================================================

import rollback from '../rollback'
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

const PRIOR = { action: 'audit', excludeZones: ['nzoLEGACY'] }

describe('threat-insight rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ prior: PRIOR }, { credential: null }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ prior: PRIOR }, { credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ prior: PRIOR }, { hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports there is nothing to roll back rather than guessing a threat posture', async () => {
    for (const data of [undefined, {}, { prior: undefined }, { previousState: [] }]) {
      await withFetch([], async (calls) => {
        const result = await rollback(rollbackContext(data))
        expect(result.success).toBe(false)
        expect(result.message).toBe('No previous state available for rollback')
        expect(calls).toHaveLength(0)
      })
    }
  })

  it('replays the captured prior configuration in one full replace', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ prior: PRIOR }))

      expect(result.success).toBe(true)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/threats/configuration')
      expect(writes[0].json).toEqual({ action: 'audit', excludeZones: ['nzoLEGACY'] })
    })
  })

  it('restores an org that had no exemptions without leaving the deploy\'s behind', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ prior: { action: 'block', excludeZones: [] } }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({ action: 'block', excludeZones: [] })
    })
  })

  it('never reads the live configuration first — the captured prior is the target', async () => {
    await withFetch([ok({})], async (calls) => {
      await rollback(rollbackContext({ prior: PRIOR }))
      expect(calls).toHaveLength(1)
      expect(calls.some((c) => c.method === 'GET')).toBe(false)
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ prior: PRIOR })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore ThreatInsight configuration/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports the restored posture in its success message', async () => {
    const result = await withFetch([ok({})], async () => rollback(rollbackContext({ prior: PRIOR })))

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/action=audit/)
    expect(result.message).toMatch(/1 exempt zone/)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
