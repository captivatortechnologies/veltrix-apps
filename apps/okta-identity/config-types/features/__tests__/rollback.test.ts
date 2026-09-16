// =============================================================================
// features — rollback, driven against the fake Okta org.
//
// Nothing was created, so nothing is deleted: rollback simply replays each
// feature's prior lifecycle state. It always sends ?mode=force, because the
// deploy it is undoing may have pulled dependent features along with it and a
// plain restore would be refused.
// =============================================================================

import rollback from '../rollback'
import type { FeatureRollbackEntry } from '../deploy'
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

function entry(overrides: Partial<FeatureRollbackEntry> = {}): FeatureRollbackEntry {
  return {
    name: 'Okta Verify Number Challenge',
    id: 'ftLIVE',
    priorStatus: 'DISABLED',
    ...overrides,
  }
}

describe('features rollback', () => {
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

  it('replays the prior lifecycle state, forcing past any dependency restriction', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [entry()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/features/ftLIVE/DISABLE')
      expect(writes[0].query.mode).toBe('force')
    })
  })

  it('re-enables a feature the deploy had switched off', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry({ priorStatus: 'ENABLED' })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/features/ftLIVE/ENABLE')
    })
  })

  it('never deletes anything — features are update-only', async () => {
    await withFetch([ok({})], async (calls) => {
      await rollback(rollbackContext({ previousState: [entry()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.method === 'GET')).toBe(false)
    })
  })

  it('replays unconditionally, because the live state is not re-read first', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry({ priorStatus: 'ENABLED' })] }),
      )

      // The lifecycle replay is idempotent, so restoring a feature that is
      // already in its prior state is harmless and needs no read.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
    })
  })

  it('normalises a lower-case prior status', async () => {
    await withFetch([ok({})], async (calls) => {
      await rollback(rollbackContext({ previousState: [entry({ priorStatus: 'enabled' })] }))
      expect(writeCalls(calls)[0].path).toBe('/features/ftLIVE/ENABLE')
    })
  })

  it('skips an entry whose prior status was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [entry({ priorStatus: '' })] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Okta Verify Number Challenge/)
      expect(calls).toHaveLength(0)
    })
  })

  it('skips an entry with no feature id', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [entry({ id: '' })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats a 404 as the feature no longer being in this org', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [entry()] }))
      expect(result.success).toBe(true)
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [entry()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore feature/)
    expect(result.message).toMatch(/to DISABLED/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [entry(), entry({ name: 'Second feature', id: 'ftTWO' })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
