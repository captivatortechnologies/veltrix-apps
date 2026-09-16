import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_BASE_URL_SETTINGS,
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
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'threat-feeds'
const FEEDS = `/threathunter/feedmgr/v2/orgs/${ORG_KEY}/feeds`

const HASH_A = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'
const HASH_B = 'bb'.repeat(32)
const FEED_NAME = 'Ransom IOCs'

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function feed(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

const FEED = feed({
  name: FEED_NAME,
  providerUrl: 'https://intel.example.com',
  summary: 'Ransomware hashes',
  iocField: 'process_hash',
  values: [HASH_A, HASH_B],
})

/** What the vendor holds before this deploy touches an adopted feed. */
const PRIOR_INFO = {
  name: FEED_NAME,
  provider_url: 'https://old.example.com',
  summary: 'old summary',
  category: 'partner_threat_intel',
  alertable: false,
}
const PRIOR_REPORTS = [
  {
    id: 'legacy-report',
    timestamp: 1_700_000_000,
    title: 'legacy',
    iocs_v2: [{ id: 'x', match_type: 'equality', field: 'process_hash', values: [HASH_A] }],
  },
]

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

describe('carbon-black threat-feeds deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([FEED], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([FEED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([FEED], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'feed-new' })], async (calls) => {
      const result = await deploy(ctx([FEED]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(FEEDS)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates a feed that does not exist yet and records it as app-created', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'feed-new' })], async (calls) => {
      const result = await deploy(ctx([FEED]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 threat feed')
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(FEEDS)

      const body = objectBody(posted[0])
      expect(body.feedinfo).toEqual({
        name: FEED_NAME,
        provider_url: 'https://intel.example.com',
        summary: 'Ransomware hashes',
        category: 'external_threat_intel',
        alertable: true,
      })
      const reports = body.reports as Array<Record<string, unknown>>
      expect(reports).toHaveLength(1)
      expect(reports[0].id).toBe('veltrix-managed-report')
      expect(reports[0].title).toBe(`${FEED_NAME} — managed IOCs`)
      expect(reports[0].description).toBe('Ransomware hashes')
      expect(reports[0].severity).toBe(5)
      expect(reports[0].iocs_v2).toEqual([
        { id: 'veltrix-iocs', match_type: 'equality', field: 'process_hash', values: [HASH_A, HASH_B] },
      ])
      expect(typeof reports[0].timestamp).toBe('number')

      // `existed: false` is what tells rollback this feed is ours to delete.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: FEED_NAME, existed: false, id: 'feed-new' },
      ])
    })
  })

  it('updates a feed that already exists and records its prior state, not the desired one', async () => {
    const live = { id: 'feed-1', name: FEED_NAME }
    await withFetch(
      [cbJson({ results: [live] }), cbJson({ feedinfo: PRIOR_INFO, reports: PRIOR_REPORTS }), cbJson({}), cbJson({})],
      async (calls) => {
        const result = await deploy(ctx([FEED]))

        expect(result.success).toBe(true)
        // Metadata and IOCs are separate endpoints — both have to be written.
        const changed = writes(calls)
        expect(changed).toHaveLength(2)
        expect(changed[0].method).toBe('PUT')
        expect(changed[0].path).toBe(`${FEEDS}/feed-1/feedinfo`)
        expect(objectBody(changed[0]).summary).toBe('Ransomware hashes')
        expect(changed[1].method).toBe('POST')
        expect(changed[1].path).toBe(`${FEEDS}/feed-1/reports`)

        // The snapshot rollback restores must be the LIVE values, not the spec's.
        expect(entries(result)).toEqual([
          {
            itemId: 'item-1',
            name: FEED_NAME,
            existed: true,
            id: 'feed-1',
            prior: { feedinfo: PRIOR_INFO, reports: PRIOR_REPORTS },
          },
        ])
      },
    )
  })

  it('reads the prior state before overwriting it', async () => {
    const live = { id: 'feed-1', name: FEED_NAME }
    await withFetch(
      [cbJson({ results: [live] }), cbJson({ feedinfo: PRIOR_INFO, reports: PRIOR_REPORTS }), cbJson({}), cbJson({})],
      async (calls) => {
        await deploy(ctx([FEED]))

        // Snapshotting after the PUT would capture this app's own values.
        expect(calls).toHaveLength(4)
        expect(calls[1].method).toBe('GET')
        expect(calls[1].path).toBe(`${FEEDS}/feed-1`)
      },
    )
  })

  it('matches an existing feed by name case-insensitively rather than creating a second one', async () => {
    const live = { id: 'feed-1', name: FEED_NAME.toUpperCase() }
    await withFetch(
      [cbJson({ results: [live] }), cbJson({ feedinfo: PRIOR_INFO, reports: PRIOR_REPORTS }), cbJson({}), cbJson({})],
      async (calls) => {
        const result = await deploy(ctx([FEED]))

        expect(result.success).toBe(true)
        expect(writes(calls)[0].path).toBe(`${FEEDS}/feed-1/feedinfo`)
        expect(entries(result)[0].existed).toBe(true)
      },
    )
  })

  it('accepts a bare-array feed listing as well as a results envelope', async () => {
    const live = { id: 'feed-1', name: FEED_NAME }
    await withFetch(
      [cbJson([live]), cbJson({ feedinfo: PRIOR_INFO, reports: PRIOR_REPORTS }), cbJson({}), cbJson({})],
      async (calls) => {
        const result = await deploy(ctx([FEED]))

        expect(result.success).toBe(true)
        expect(writes(calls)[0].path).toBe(`${FEEDS}/feed-1/feedinfo`)
      },
    )
  })

  it('reports failure rather than throwing when the vendor rejects the create', async () => {
    await withFetch([EMPTY_LIST, cbError('feed name already in use', 400)], async () => {
      const result = await deploy(ctx([FEED]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('Ransom IOCs: feed name already in use')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('names the IOC upload as the failing step when the reports POST is rejected', async () => {
    const live = { id: 'feed-1', name: FEED_NAME }
    await withFetch(
      [
        cbJson({ results: [live] }),
        cbJson({ feedinfo: PRIOR_INFO, reports: PRIOR_REPORTS }),
        cbJson({}),
        cbError('report payload too large', 413),
      ],
      async () => {
        const result = await deploy(ctx([FEED]))

        expect(result.success).toBe(false)
        expect(result.message).toContain('reports: report payload too large')
      },
    )
  })

  it('stops at the listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([FEED]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list feeds/)
      expect(result.message).toContain('forbidden')
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deletes a feed it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'Retired feed', existed: false, id: 'feed-old' }]
    await withFetch([EMPTY_LIST, cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${FEEDS}/feed-old`)
    })
  })

  it('never deletes a feed it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'Partner feed', existed: true, id: 'feed-them' }]
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'feed-new' })], async () => {
      const result = await deploy(ctx([FEED], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([EMPTY_LIST, cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([FEED]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
