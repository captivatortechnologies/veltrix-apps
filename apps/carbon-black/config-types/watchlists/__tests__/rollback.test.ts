import rollback from '../rollback'
import type { RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  cbNotFound,
  mentionsSecret,
  objectBody,
  rollbackContext,
  withFetch,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'watchlists'
const WATCHLISTS = `/threathunter/watchlistmgr/v3/orgs/${ORG_KEY}/watchlists`

const PRIOR = {
  name: 'Ransomware',
  description: 'old description',
  tags_enabled: false,
  alerts_enabled: false,
  classifier: { key: 'feed_id', value: 'OLDFEED' },
}

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black watchlists rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx([{ name: 'Ransomware', existed: false, watchlistId: 'wl-1' }], { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx([{ name: 'Ransomware', existed: false, watchlistId: 'wl-1' }], { settings: NO_ORG_KEY_SETTINGS }),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a watchlist the deploy created', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: 'Ransomware', existed: false, watchlistId: 'wl-new' }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${WATCHLISTS}/wl-new`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('restores the exact prior state of a watchlist the deploy adopted', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([{ name: 'Ransomware', existed: true, watchlistId: 'wl-1', prior: PRIOR }]),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(`${WATCHLISTS}/wl-1`)
      // The pre-deploy snapshot goes back verbatim — that is the whole point.
      expect(objectBody(calls[0])).toEqual(PRIOR)
      expect(result.message).toContain('1 restored')
    })
  })

  it('does nothing when there is no rollback state at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does nothing for an empty entry list', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('skips an entry whose watchlist id was never recorded', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: 'Ransomware', existed: false }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('leaves an adopted watchlist untouched when no prior snapshot was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: 'Ransomware', existed: true, watchlistId: 'wl-1' }]))

      // Restoring from nothing would blank a watchlist this app does not own.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted watchlist as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: 'Ransomware', existed: false, watchlistId: 'wl-gone' }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('reports failure rather than throwing when the vendor rejects a restore', async () => {
    await withFetch([cbError('watchlist is read-only', 409)], async () => {
      const result = await rollback(
        ctx([{ name: 'Ransomware', existed: true, watchlistId: 'wl-1', prior: PRIOR }]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toContain('watchlist is read-only')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([
          { name: 'First', existed: false, watchlistId: 'wl-1' },
          { name: 'Second', existed: false, watchlistId: 'wl-2' },
        ]),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].path).toBe(`${WATCHLISTS}/wl-2`)
    })
  })
})
