import driftDetect from '../driftDetect'
import type { RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  cbNotFound,
  driftContext,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'watchlist-reports'
const REPORTS = `/threathunter/watchlistmgr/v3/orgs/${ORG_KEY}/reports`

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

function report(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.title ?? ''), fields }
}

const DEPLOYED = report({
  title: 'Known bad hashes',
  description: 'blocked hashes',
  severity: 8,
  iocField: 'process_hash',
  values: HASH,
})

const IN_SYNC = {
  id: 'rep-1',
  title: 'Known bad hashes',
  description: 'blocked hashes',
  severity: 8,
  timestamp: 1700000000,
  iocs_v2: [{ id: 'item-1-iocs', match_type: 'equality', field: 'process_hash', values: [HASH] }],
}

/** The store has no list-all, so the stored entries are the only id source. */
const PRIOR: RollbackEntry[] = [
  { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-1', existed: false },
]

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, priorEntries: PRIOR, ...opts })
}

describe('carbon-black watchlist-reports driftDetect handler', () => {
  it('reports no drift without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('does not call the vendor when nothing is declared', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([]))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when there is no previous deployment to resolve ids from', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { priorEntries: undefined }))

      // Nothing was ever deployed, so there is no server id to read and nothing
      // to call absent.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the platform cannot supply the previous deployment', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { platformThrows: true }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when the live report matches what was deployed', async () => {
    await withFetch([cbJson(IN_SYNC)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(`${REPORTS}/rep-1`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted report as critical — the IOCs it carried no longer match', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Known bad hashes')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags a description edited out of band', async () => {
    await withFetch([cbJson({ ...IN_SYNC, description: 'edited' })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Known bad hashes.description')!
      expect(diff.expected).toBe('blocked hashes')
      expect(diff.actual).toBe('edited')
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags severity lowered out of band', async () => {
    await withFetch([cbJson({ ...IN_SYNC, severity: 1 })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Known bad hashes.severity')!
      expect(diff.expected).toBe(8)
      expect(diff.actual).toBe(1)
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags the IOC values being replaced', async () => {
    const swapped = { ...IN_SYNC, iocs_v2: [{ id: 'x', match_type: 'equality', field: 'process_hash', values: ['deadbeef'] }] }
    await withFetch([cbJson(swapped)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Known bad hashes.values')!
      expect(diff.expected).toEqual([HASH])
      expect(diff.actual).toEqual(['deadbeef'])
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags IOCs moved to another match field as a loss of the declared values', async () => {
    const moved = { ...IN_SYNC, iocs_v2: [{ id: 'x', match_type: 'equality', field: 'netconn_domain', values: [HASH] }] }
    await withFetch([cbJson(moved)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // Nothing matches on process_hash any more, so the declared hashes are live nowhere.
      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Known bad hashes.values')!
      expect(diff.actual).toEqual([])
    })
  })

  it('resolves the report id by title when the canvas item id has changed', async () => {
    const renumbered: RollbackEntry[] = [
      { itemId: 'item-99', title: 'Known bad hashes', reportId: 'rep-1', existed: false },
    ]
    await withFetch([cbJson(IN_SYNC)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { priorEntries: renumbered }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(`${REPORTS}/rep-1`)
    })
  })

  it('reports no drift when the vendor read fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })
  })

  it('skips a newly added report that no deployment has created yet', async () => {
    const fresh = report({
      title: 'Brand new',
      description: 'd',
      severity: 5,
      iocField: 'process_hash',
      values: HASH,
    })
    await withFetch([cbJson(IN_SYNC)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED, fresh]))

      // It has no server id yet; absence is pending deployment, not drift.
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(1)
    })
  })
})
