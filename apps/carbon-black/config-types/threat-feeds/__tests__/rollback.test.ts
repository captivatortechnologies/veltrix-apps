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

const CONFIG_TYPE = 'threat-feeds'
const FEEDS = `/threathunter/feedmgr/v2/orgs/${ORG_KEY}/feeds`

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'
const FEED_NAME = 'Ransom IOCs'

/** The feedinfo + reports deploy captured before it overwrote the feed. */
const PRIOR = {
  feedinfo: {
    name: FEED_NAME,
    provider_url: 'https://old.example.com',
    summary: 'old summary',
    category: 'partner_threat_intel',
    alertable: false,
  },
  reports: [
    {
      id: 'legacy-report',
      timestamp: 1_700_000_000,
      title: 'legacy',
      iocs_v2: [{ id: 'x', match_type: 'equality', field: 'process_hash', values: [HASH] }],
    },
  ],
}

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black threat-feeds rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: false, id: 'feed-1' }], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx([{ name: FEED_NAME, existed: false, id: 'feed-1' }], { settings: NO_ORG_KEY_SETTINGS }),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a feed the deploy created', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: false, id: 'feed-new' }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${FEEDS}/feed-new`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('restores the exact prior metadata and reports of a feed the deploy adopted', async () => {
    await withFetch([cbJson({}), cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: true, id: 'feed-1', prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(`${FEEDS}/feed-1/feedinfo`)
      // The pre-deploy snapshot goes back verbatim — that is the whole point.
      expect(objectBody(calls[0])).toEqual(PRIOR.feedinfo)
      expect(calls[1].method).toBe('POST')
      expect(calls[1].path).toBe(`${FEEDS}/feed-1/reports`)
      expect(objectBody(calls[1])).toEqual({ reports: PRIOR.reports })
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

  it('skips an entry whose feed id was never recorded', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: false }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('leaves an adopted feed untouched when no prior snapshot was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: true, id: 'feed-1' }]))

      // Restoring from nothing would blank a feed this app does not own.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted feed as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: false, id: 'feed-gone' }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('treats a feed that vanished under a restore as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound(), cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: true, id: 'feed-gone', prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 restored')
    })
  })

  it('reports failure rather than throwing when the vendor rejects a restore', async () => {
    await withFetch([cbError('feed is read-only', 409), cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: true, id: 'feed-1', prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('feed is read-only')
      expect(mentionsSecret(result.message)).toBe(false)
      // The IOCs are still put back even though the metadata restore failed.
      expect(calls).toHaveLength(2)
    })
  })

  it('surfaces a rejected report restore separately from the metadata restore', async () => {
    await withFetch([cbJson({}), cbError('report payload too large', 413)], async () => {
      const result = await rollback(ctx([{ name: FEED_NAME, existed: true, id: 'feed-1', prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('reports: report payload too large')
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([
          { name: 'First feed', existed: false, id: 'feed-1' },
          { name: 'Second feed', existed: false, id: 'feed-2' },
        ]),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].path).toBe(`${FEEDS}/feed-2`)
    })
  })
})
