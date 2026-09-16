import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  deployContext,
  mentionsSecret,
  objectBody,
  withFetch,
  writes,
  type ItemInput,
  type RecordedCall,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'feed-reports'
const FEEDS = `/threathunter/feedmgr/v2/orgs/${ORG_KEY}/feeds`
const REPORTS = `${FEEDS}/feed-1/reports`

const FEED = { id: 'feed-1', name: 'Internal IOCs' }
const OTHER_FEED = { id: 'feed-2', name: 'External IOCs' }
const FEED_LIST = cbJson({ results: [FEED] })

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

/** A report this app does not own — the feed's other reports must survive a deploy. */
const FOREIGN = {
  id: 'analyst-report-1',
  title: 'Analyst hunt',
  description: 'hand-written by the SOC',
  severity: 3,
  timestamp: 1700000000,
  iocs_v2: [{ id: 'analyst-iocs', match_type: 'equality', field: 'netconn_domain', values: ['evil.example'] }],
}

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function report(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.title ?? ''), fields }
}

const SPEC = report({
  feedName: 'Internal IOCs',
  title: 'Known bad hashes',
  description: 'blocked hashes',
  severity: 8,
  iocField: 'process_hash',
  values: HASH,
})

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

/** The replacement report set a `POST .../reports` carries. */
function reportsIn(call: RecordedCall | undefined): Array<Record<string, unknown>> {
  const reports = objectBody(call).reports
  return Array.isArray(reports) ? (reports as Array<Record<string, unknown>>) : []
}

/** The report minus its Date.now()-derived timestamp, which no fixture can pin. */
function withoutTimestamp(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body }
  delete copy.timestamp
  return copy
}

describe('carbon-black feed-reports deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SPEC], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SPEC], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([FEED_LIST, EMPTY_LIST, cbJson({})], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].path).toBe(FEEDS)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates a report the feed does not have and records it as app-created', async () => {
    await withFetch([FEED_LIST, EMPTY_LIST, cbJson({})], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(REPORTS)

      const reports = reportsIn(posted[0])
      expect(reports).toHaveLength(1)
      expect(typeof reports[0].timestamp).toBe('number')
      expect(withoutTimestamp(reports[0])).toEqual({
        id: 'veltrix-item-1',
        title: 'Known bad hashes',
        description: 'blocked hashes',
        severity: 8,
        iocs_v2: [{ id: 'veltrix-item-1-iocs', match_type: 'equality', field: 'process_hash', values: [HASH] }],
      })

      // `existed: false` is what tells reconcile and rollback this report is ours.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          feedName: 'Internal IOCs',
          feedId: 'feed-1',
          title: 'Known bad hashes',
          reportId: 'veltrix-item-1',
          existed: false,
          prior: undefined,
        },
      ])
    })
  })

  it('carries the feed\'s other reports through the replacement it posts', async () => {
    await withFetch([FEED_LIST, cbJson({ results: [FOREIGN] }), cbJson({})], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      const reports = reportsIn(writes(calls)[0])
      // POST .../reports REPLACES the feed's whole report set. Dropping a report
      // this app never created silently deletes a customer's own detections.
      expect(reports).toHaveLength(2)
      expect(reports[0]).toEqual(FOREIGN)
      expect(reports[1].id).toBe('veltrix-item-1')
    })
  })

  it('adopts a live report of the same title and records its prior state, not the desired one', async () => {
    const live = {
      id: 'existing-1',
      title: 'Known bad hashes',
      description: 'old description',
      severity: 2,
      timestamp: 1699999999,
      iocs_v2: [{ id: 'old-iocs', match_type: 'equality', field: 'process_hash', values: ['deadbeef'] }],
    }
    await withFetch([FEED_LIST, cbJson({ results: [live] }), cbJson({})], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      const reports = reportsIn(writes(calls)[0])
      // Reusing the live id overwrites the report rather than duplicating it.
      expect(reports).toHaveLength(1)
      expect(reports[0].id).toBe('existing-1')
      expect(reports[0].description).toBe('blocked hashes')

      // The snapshot rollback restores must be the LIVE values, not the spec's.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          feedName: 'Internal IOCs',
          feedId: 'feed-1',
          title: 'Known bad hashes',
          reportId: 'existing-1',
          existed: true,
          prior: live,
        },
      ])
    })
  })

  it('writes each feed its own report set so one feed never inherits another\'s', async () => {
    const second = report({
      feedName: 'External IOCs',
      title: 'Known bad domains',
      description: 'blocked domains',
      severity: 4,
      iocField: 'netconn_domain',
      values: 'evil.test',
    })
    await withFetch(
      [cbJson({ results: [FEED, OTHER_FEED] }), EMPTY_LIST, cbJson({}), EMPTY_LIST, cbJson({})],
      async (calls) => {
        const result = await deploy(ctx([SPEC, second]))

        expect(result.success).toBe(true)
        const posted = writes(calls)
        expect(posted).toHaveLength(2)
        expect(posted[0].path).toBe(REPORTS)
        expect(reportsIn(posted[0])[0].title).toBe('Known bad hashes')
        expect(posted[1].path).toBe(`${FEEDS}/feed-2/reports`)
        expect(reportsIn(posted[1])[0].title).toBe('Known bad domains')
      },
    )
  })

  it('reports failure rather than throwing when the vendor rejects the report set', async () => {
    await withFetch([FEED_LIST, EMPTY_LIST, cbError('report limit exceeded', 400)], async () => {
      const result = await deploy(ctx([SPEC]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('report limit exceeded')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('stops at the feed listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list feeds/)
      expect(result.message).toContain('forbidden')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('stops at the report listing failure rather than replacing a set it could not read', async () => {
    await withFetch([FEED_LIST, cbError('service unavailable', 503)], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      // Posting a replacement set built from an unreadable listing would wipe
      // every report already in the feed.
      expect(result.success).toBe(false)
      expect(result.message).toContain('failed to list reports')
      expect(result.message).toContain('service unavailable')
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('fails loudly when the parent feed does not exist instead of silently doing nothing', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('Internal IOCs: feed not found')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('drops a report it created before but no longer declares, keeping the rest', async () => {
    const retired = { id: 'veltrix-item-9', title: 'Retired', description: 'gone', severity: 5, timestamp: 1700000001 }
    const prior: RollbackEntry[] = [
      { itemId: 'item-9', feedName: 'Internal IOCs', feedId: 'feed-1', title: 'Retired', reportId: 'veltrix-item-9', existed: false },
    ]
    await withFetch([FEED_LIST, cbJson({ results: [FOREIGN, retired] }), cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(REPORTS)
      expect(reportsIn(posted[0])).toEqual([FOREIGN])
    })
  })

  it('never drops a report it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-9', feedName: 'Internal IOCs', feedId: 'feed-1', title: 'Analyst hunt', reportId: 'analyst-report-1', existed: true },
    ]
    await withFetch([FEED_LIST, cbJson({ results: [FOREIGN] })], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([FEED_LIST, EMPTY_LIST, cbJson({})], async () => {
      const result = await deploy(ctx([SPEC], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([FEED_LIST, EMPTY_LIST, cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
