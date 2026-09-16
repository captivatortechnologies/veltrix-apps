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
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'watchlists'
const WATCHLISTS = `/threathunter/watchlistmgr/v3/orgs/${ORG_KEY}/watchlists`

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function watchlist(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

describe('carbon-black watchlists deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([watchlist({ name: 'Ransomware', feedId: 'F1' })], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        ctx([watchlist({ name: 'Ransomware', feedId: 'F1' })], { settings: NO_ORG_KEY_SETTINGS }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'wl-new' })], async (calls) => {
      const result = await deploy(ctx([watchlist({ name: 'Ransomware', feedId: 'F1' })]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].path).toBe(WATCHLISTS)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates a watchlist that does not exist yet and records it as app-created', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'wl-new' })], async (calls) => {
      const result = await deploy(
        ctx([watchlist({ name: 'Ransomware', description: 'ioc feed', feedId: 'FID1', tags_enabled: true, alerts_enabled: true })]),
      )

      expect(result.success).toBe(true)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(WATCHLISTS)
      expect(objectBody(posted[0])).toEqual({
        name: 'Ransomware',
        description: 'ioc feed',
        tags_enabled: true,
        alerts_enabled: true,
        classifier: { key: 'feed_id', value: 'FID1' },
      })
      // `existed: false` is what tells rollback this watchlist is ours to delete.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: 'Ransomware', existed: false, watchlistId: 'wl-new' },
      ])
    })
  })

  it('updates a watchlist that already exists and records its prior state, not the desired one', async () => {
    const live = {
      id: 'wl-1',
      name: 'Ransomware',
      description: 'old description',
      tags_enabled: false,
      alerts_enabled: false,
      classifier: { key: 'feed_id', value: 'OLDFEED' },
    }
    await withFetch([cbJson({ results: [live] }), cbJson({ id: 'wl-1' })], async (calls) => {
      const result = await deploy(
        ctx([watchlist({ name: 'Ransomware', description: 'new description', feedId: 'FID1', tags_enabled: true, alerts_enabled: true })]),
      )

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(`${WATCHLISTS}/wl-1`)
      expect(objectBody(put[0]).description).toBe('new description')

      // The snapshot rollback restores must be the LIVE values, not the spec's.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: 'Ransomware',
          existed: true,
          watchlistId: 'wl-1',
          prior: {
            name: 'Ransomware',
            description: 'old description',
            tags_enabled: false,
            alerts_enabled: false,
            classifier: { key: 'feed_id', value: 'OLDFEED' },
          },
        },
      ])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the create', async () => {
    await withFetch([EMPTY_LIST, cbError('watchlist quota exceeded', 400)], async () => {
      const result = await deploy(ctx([watchlist({ name: 'Ransomware', feedId: 'F1' })]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('watchlist quota exceeded')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('stops at the listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([watchlist({ name: 'Ransomware', feedId: 'F1' })]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list watchlists/)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deletes a watchlist it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'Retired', existed: false, watchlistId: 'wl-old' }]
    await withFetch([EMPTY_LIST, cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${WATCHLISTS}/wl-old`)
    })
  })

  it('never deletes a watchlist it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'PreExisting', existed: true, watchlistId: 'wl-them' }]
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'wl-new' })], async () => {
      const result = await deploy(
        ctx([watchlist({ name: 'Ransomware', feedId: 'F1' })], { platformThrows: true }),
      )

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([EMPTY_LIST, cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([watchlist({ name: 'Ransomware', feedId: 'F1' })]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
