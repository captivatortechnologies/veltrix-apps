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

const CONFIG_TYPE = 'threat-feeds'
const FEEDS = `/threathunter/feedmgr/v2/orgs/${ORG_KEY}/feeds`

const HASH_A = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'
const HASH_B = 'bb'.repeat(32)
const FEED_NAME = 'Ransom IOCs'

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function feed(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

const DEPLOYED = feed({
  name: FEED_NAME,
  providerUrl: 'https://intel.example.com',
  summary: 'Ransomware hashes',
  iocField: 'process_hash',
  values: [HASH_A, HASH_B],
})

const LISTED = cbJson({ results: [{ id: 'feed-1', name: FEED_NAME }] })

function detail(summary: string, values: string[], field = 'process_hash') {
  return cbJson({
    feedinfo: { summary, category: 'external_threat_intel' },
    reports: [{ iocs_v2: [{ field, values }] }],
  })
}

const IN_SYNC = detail('Ransomware hashes', [HASH_A, HASH_B])

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black threat-feeds driftDetect handler', () => {
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

  it('finds no drift when the live feed matches what was deployed', async () => {
    await withFetch([LISTED, IN_SYNC], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe(FEEDS)
      expect(calls[1].path).toBe(`${FEEDS}/feed-1`)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted feed as critical — nothing is matching those IOCs any more', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe(FEED_NAME)
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
      // There is nothing to read the detail of, so it must not try.
      expect(calls).toHaveLength(1)
    })
  })

  it('flags a listed feed carrying no id as absent rather than reading it', async () => {
    await withFetch([cbJson({ results: [{ name: FEED_NAME }] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].severity).toBe('critical')
      expect(calls).toHaveLength(1)
    })
  })

  it('flags an edited summary', async () => {
    await withFetch([LISTED, detail('rewritten by hand', [HASH_A, HASH_B])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(fields(result)).toContain(`${FEED_NAME}.summary`)
      const diff = result.diffs.find((d) => d.field === `${FEED_NAME}.summary`)!
      expect(diff.expected).toBe('Ransomware hashes')
      expect(diff.actual).toBe('rewritten by hand')
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags IOC values removed from the feed out of band', async () => {
    await withFetch([LISTED, detail('Ransomware hashes', [HASH_A])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === `${FEED_NAME}.values`)!
      expect(diff.expected).toEqual([HASH_A, HASH_B])
      expect(diff.actual).toEqual([HASH_A])
      expect(diff.severity).toBe('warning')
    })
  })

  it('does not count IOC values matching on a different field', async () => {
    await withFetch([LISTED, detail('Ransomware hashes', [HASH_A, HASH_B], 'netconn_domain')], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // Hashes re-filed under a domain match protect nothing the spec declared.
      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === `${FEED_NAME}.values`)!
      expect(diff.actual).toEqual([])
    })
  })

  it('ignores the order the vendor returns IOC values in', async () => {
    await withFetch([LISTED, detail('Ransomware hashes', [HASH_B, HASH_A])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('accepts a bare-array feed listing as well as a results envelope', async () => {
    await withFetch([cbJson([{ id: 'feed-1', name: FEED_NAME }]), IN_SYNC], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(2)
    })
  })

  it('reports no drift when the vendor listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })
  })

  it('reports no drift for a feed whose detail read fails, rather than guessing', async () => {
    await withFetch([LISTED, cbError('service unavailable', 503)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(2)
    })
  })
})
