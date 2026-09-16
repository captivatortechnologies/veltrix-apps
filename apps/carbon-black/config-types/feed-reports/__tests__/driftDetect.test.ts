import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  driftContext,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'feed-reports'
const FEEDS = `/threathunter/feedmgr/v2/orgs/${ORG_KEY}/feeds`
const REPORTS = `${FEEDS}/feed-1/reports`

const FEED = { id: 'feed-1', name: 'Internal IOCs' }
const FEED_LIST = cbJson({ results: [FEED] })

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function report(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.title ?? ''), fields }
}

const DEPLOYED = report({
  feedName: 'Internal IOCs',
  title: 'Known bad hashes',
  description: 'blocked hashes',
  severity: 8,
  iocField: 'process_hash',
  values: HASH,
})

const IN_SYNC = {
  id: 'veltrix-item-1',
  title: 'Known bad hashes',
  description: 'blocked hashes',
  severity: 8,
  timestamp: 1700000000,
  iocs_v2: [{ id: 'veltrix-item-1-iocs', match_type: 'equality', field: 'process_hash', values: [HASH] }],
}

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black feed-reports driftDetect handler', () => {
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

  it('finds no drift when the live report matches what was deployed', async () => {
    await withFetch([FEED_LIST, cbJson({ results: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe(FEEDS)
      expect(calls[1].path).toBe(REPORTS)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted parent feed as critical and never looks for its reports', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Known bad hashes')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
      expect(calls).toHaveLength(1)
    })
  })

  it('flags a deleted report as critical — the IOCs it carried no longer match', async () => {
    await withFetch([FEED_LIST, EMPTY_LIST], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Known bad hashes')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags a description edited out of band', async () => {
    await withFetch([FEED_LIST, cbJson({ results: [{ ...IN_SYNC, description: 'edited' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Known bad hashes.description')!
      expect(diff.expected).toBe('blocked hashes')
      expect(diff.actual).toBe('edited')
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags severity lowered out of band', async () => {
    await withFetch([FEED_LIST, cbJson({ results: [{ ...IN_SYNC, severity: 1 }] })], async () => {
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
    await withFetch([FEED_LIST, cbJson({ results: [swapped] })], async () => {
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
    await withFetch([FEED_LIST, cbJson({ results: [moved] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // Nothing matches on process_hash any more, so the declared hashes are live nowhere.
      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Known bad hashes.values')!
      expect(diff.actual).toEqual([])
    })
  })

  it('matches the live report by title case-insensitively', async () => {
    await withFetch([FEED_LIST, cbJson({ results: [{ ...IN_SYNC, title: 'KNOWN BAD HASHES' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('lists a feed once however many reports it holds', async () => {
    const second = report({
      feedName: 'Internal IOCs',
      title: 'Known bad domains',
      description: 'blocked domains',
      severity: 4,
      iocField: 'netconn_domain',
      values: 'evil.test',
    })
    const liveSecond = {
      id: 'veltrix-item-2',
      title: 'Known bad domains',
      description: 'blocked domains',
      severity: 4,
      iocs_v2: [{ id: 'veltrix-item-2-iocs', match_type: 'equality', field: 'netconn_domain', values: ['evil.test'] }],
    }
    await withFetch([FEED_LIST, cbJson({ results: [IN_SYNC, liveSecond] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED, second]))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(2)
    })
  })

  it('reports no drift when the feed listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })
  })

  it('reports drift on the reports it can read without being stopped by an unknown feed', async () => {
    const orphan = report({
      feedName: 'Missing Feed',
      title: 'Orphan',
      description: 'd',
      severity: 5,
      iocField: 'process_hash',
      values: HASH,
    })
    await withFetch([FEED_LIST, cbJson({ results: [IN_SYNC] })], async () => {
      const result = await driftDetect(ctx([orphan, DEPLOYED]))

      expect(fields(result)).toEqual(['Orphan'])
      expect(result.diffs[0].severity).toBe('critical')
    })
  })
})
