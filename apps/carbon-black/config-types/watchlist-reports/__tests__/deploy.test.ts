import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  cbNotFound,
  deployContext,
  mentionsSecret,
  objectBody,
  withFetch,
  writes,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'watchlist-reports'
const REPORTS = `/threathunter/watchlistmgr/v3/orgs/${ORG_KEY}/reports`

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function report(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.title ?? ''), fields }
}

const SPEC = report({
  title: 'Known bad hashes',
  description: 'blocked hashes',
  severity: 8,
  iocField: 'process_hash',
  values: HASH,
  tags: 'ransomware, apt',
})

/** The report as the vendor holds it before this deploy overwrites it. */
const LIVE = {
  id: 'rep-1',
  title: 'Known bad hashes',
  description: 'old description',
  severity: 2,
  timestamp: 1699999999,
  iocs_v2: [{ id: 'old-iocs', match_type: 'equality', field: 'process_hash', values: ['deadbeef'] }],
}

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

/** The report minus its Date.now()-derived timestamp, which no fixture can pin. */
function withoutTimestamp(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body }
  delete copy.timestamp
  return copy
}

describe('carbon-black watchlist-reports deploy handler', () => {
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
    await withFetch([cbJson({ id: 'rep-1' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].path).toBe(REPORTS)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates a report when no previous deployment recorded one', async () => {
    await withFetch([cbJson({ id: 'rep-1' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(REPORTS)

      const body = objectBody(posted[0])
      expect(typeof body.timestamp).toBe('number')
      // No `id` on a create — the shared reports store assigns it.
      expect(withoutTimestamp(body)).toEqual({
        title: 'Known bad hashes',
        description: 'blocked hashes',
        severity: 8,
        tags: ['ransomware', 'apt'],
        iocs_v2: [{ id: 'item-1-iocs', match_type: 'equality', field: 'process_hash', values: [HASH] }],
      })

      // `existed: false` is what tells reconcile and rollback this report is ours.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-1', existed: false },
      ])
    })
  })

  it('updates the report the previous deployment recorded and snapshots its live state', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-1', existed: false },
    ]
    await withFetch([cbJson(LIVE), cbJson({})], async (calls) => {
      const result = await deploy(ctx([SPEC], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(`${REPORTS}/rep-1`)

      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(`${REPORTS}/rep-1`)
      // An update must carry the id the store assigned, or it addresses nothing.
      expect(objectBody(put[0]).id).toBe('rep-1')
      expect(objectBody(put[0]).description).toBe('blocked hashes')

      // The snapshot rollback restores must be the LIVE values, not the spec's.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-1', existed: false, prior: LIVE },
      ])
    })
  })

  it('keeps the original pre-adoption snapshot instead of re-snapshotting its own writes', async () => {
    const original = { ...LIVE, description: 'what the customer had' }
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-1', existed: true, prior: original },
    ]
    const ours = { ...LIVE, description: 'blocked hashes' }
    await withFetch([cbJson(ours), cbJson({})], async () => {
      const result = await deploy(ctx([SPEC], { priorEntries: prior }))

      expect(result.success).toBe(true)
      // Re-snapshotting on every deploy would overwrite the only record of the
      // state this app adopted, making rollback restore its own values.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-1', existed: true, prior: original },
      ])
    })
  })

  it('recreates a report that was deleted out of band rather than failing the deploy', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-gone', existed: false },
    ]
    await withFetch([cbNotFound(), cbJson({ id: 'rep-new' })], async (calls) => {
      const result = await deploy(ctx([SPEC], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(REPORTS)
      expect(objectBody(posted[0]).id).toBeUndefined()
      expect(entries(result)).toEqual([
        { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-new', existed: false },
      ])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the create', async () => {
    await withFetch([cbError('report limit exceeded', 400)], async () => {
      const result = await deploy(ctx([SPEC]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('report limit exceeded')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the update', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', title: 'Known bad hashes', reportId: 'rep-1', existed: false },
    ]
    await withFetch([cbJson(LIVE), cbError('report is read-only', 409)], async (calls) => {
      const result = await deploy(ctx([SPEC], { priorEntries: prior }))

      expect(result.success).toBe(false)
      expect(result.message).toContain('report is read-only')
      expect(entries(result)).toEqual([])
      // A failed update must not then be treated as an undeclared leftover.
      expect(writes(calls)).toHaveLength(1)
    })
  })

  it('deletes a report it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', title: 'Retired', reportId: 'rep-old', existed: false }]
    await withFetch([cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${REPORTS}/rep-old`)
    })
  })

  it('never deletes a report it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', title: 'Adopted', reportId: 'rep-them', existed: true }]
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted leftover as reconciled, not as a failure', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', title: 'Retired', reportId: 'rep-old', existed: false }]
    await withFetch([cbNotFound()], async () => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
    })
  })

  it('surfaces the vendor reason when a reconcile delete is refused', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', title: 'Retired', reportId: 'rep-old', existed: false }]
    await withFetch([cbError('report is referenced by a watchlist', 409)], async () => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(false)
      expect(result.message).toContain('delete Retired')
      expect(result.message).toContain('report is referenced by a watchlist')
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([cbJson({ id: 'rep-1' })], async (calls) => {
      const result = await deploy(ctx([SPEC], { platformThrows: true }))

      // Without the prior entries there is no stored id, so it creates afresh.
      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
      expect(writes(calls)[0].method).toBe('POST')
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([cbError('unauthorized', 401)], async (calls) => {
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
