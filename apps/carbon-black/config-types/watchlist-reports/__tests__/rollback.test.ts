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

const CONFIG_TYPE = 'watchlist-reports'
const REPORTS = `/threathunter/watchlistmgr/v3/orgs/${ORG_KEY}/reports`

const PRIOR = {
  id: 'rep-1',
  title: 'Known bad hashes',
  description: 'old description',
  severity: 2,
  timestamp: 1699999999,
  iocs_v2: [{ id: 'old-iocs', match_type: 'equality', field: 'process_hash', values: ['deadbeef'] }],
}

function entry(overrides: Partial<RollbackEntry> = {}): RollbackEntry {
  return { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-1', existed: false, ...overrides }
}

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black watchlist-reports rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([entry()], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([entry()], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a report the deploy created', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([entry()]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${REPORTS}/rep-1`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('restores the exact prior state of a report the deploy adopted', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([entry({ existed: true, prior: PRIOR })]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(`${REPORTS}/rep-1`)
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

  it('skips an entry whose report id was never recorded', async () => {
    await withFetch([], async (calls) => {
      // A create that failed before the store assigned an id leaves no target.
      const result = await rollback(ctx([entry({ reportId: undefined })]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('leaves an adopted report untouched when no prior snapshot was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([entry({ existed: true })]))

      // Restoring from nothing would blank a report this app does not own.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted report as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([entry({ reportId: 'rep-gone' })]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('reports failure rather than throwing when the vendor rejects a restore', async () => {
    await withFetch([cbError('report is read-only', 409)], async () => {
      const result = await rollback(ctx([entry({ existed: true, prior: PRIOR })]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('report is read-only')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([
          entry({ itemId: 'item-1', title: 'First', reportId: 'rep-1' }),
          entry({ itemId: 'item-2', title: 'Second', reportId: 'rep-2' }),
        ]),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].path).toBe(`${REPORTS}/rep-2`)
    })
  })
})
