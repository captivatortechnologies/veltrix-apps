import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  EMPTY_SEARCH,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  deployContext,
  mentionsSecret,
  objectBody,
  searchPage,
  withFetch,
  writes,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'reputation-overrides'
const OVERRIDES = `/appservices/v6/orgs/${ORG_KEY}/reputations/overrides`
const SEARCH = `${OVERRIDES}/_search`

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'
/** The natural key an override is matched on — a hash ban keys on the hash. */
const KEY = `sha256:${HASH}`

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function override(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.label ?? ''), fields }
}

const BAN = override({
  label: 'Bad exe',
  overrideList: 'BLACK_LIST',
  overrideType: 'SHA256',
  sha256Hash: HASH,
  filename: 'bad.exe',
  description: 'ban it',
})

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

describe('carbon-black reputation-overrides deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([BAN], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([BAN], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([BAN], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([EMPTY_SEARCH, cbJson({ id: 'ov-new' })], async (calls) => {
      const result = await deploy(ctx([BAN]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].path).toBe(SEARCH)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates an override that does not exist yet and records it as app-created', async () => {
    await withFetch([EMPTY_SEARCH, cbJson({ id: 'ov-new' })], async (calls) => {
      const result = await deploy(ctx([BAN]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 reputation override')
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(OVERRIDES)
      expect(objectBody(posted[0])).toEqual({
        override_list: 'BLACK_LIST',
        override_type: 'SHA256',
        description: 'ban it',
        sha256_hash: HASH,
        filename: 'bad.exe',
      })
      // `existed: false` is what tells rollback this override is ours to delete.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: KEY, existed: false, id: 'ov-new', prior: undefined },
      ])
    })
  })

  it('replaces a live override that differs, deleting before creating', async () => {
    const live = {
      id: 'ov-1',
      override_list: 'WHITE_LIST',
      override_type: 'SHA256',
      sha256_hash: HASH,
      filename: 'old.exe',
      description: 'vendor allow',
    }
    await withFetch([searchPage([live]), cbJson({}), cbJson({ id: 'ov-2' })], async (calls) => {
      const result = await deploy(ctx([BAN]))

      expect(result.success).toBe(true)
      // There is no update API — the old row must go before the new one lands.
      const changed = writes(calls)
      expect(changed).toHaveLength(2)
      expect(changed[0].method).toBe('DELETE')
      expect(changed[0].path).toBe(`${OVERRIDES}/ov-1`)
      expect(changed[1].method).toBe('POST')
      expect(changed[1].path).toBe(OVERRIDES)
      expect(objectBody(changed[1]).override_list).toBe('BLACK_LIST')

      // The snapshot rollback recreates must be the LIVE values, not the spec's.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: KEY,
          existed: true,
          id: 'ov-2',
          prior: {
            override_list: 'WHITE_LIST',
            override_type: 'SHA256',
            sha256_hash: HASH,
            filename: 'old.exe',
            description: 'vendor allow',
          },
        },
      ])
    })
  })

  it('leaves an already-correct override alone but still records it as adopted', async () => {
    const live = {
      id: 'ov-1',
      override_list: 'BLACK_LIST',
      override_type: 'SHA256',
      sha256_hash: HASH,
      filename: 'bad.exe',
      description: 'ban it',
    }
    await withFetch([searchPage([live])], async (calls) => {
      const result = await deploy(ctx([BAN]))

      expect(result.success).toBe(true)
      // Deleting and recreating an identical row would churn the override id.
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: KEY,
          existed: true,
          id: 'ov-1',
          prior: {
            override_list: 'BLACK_LIST',
            override_type: 'SHA256',
            sha256_hash: HASH,
            filename: 'bad.exe',
            description: 'ban it',
          },
        },
      ])
    })
  })

  it('carries the original pre-management snapshot forward instead of re-snapshotting', async () => {
    const original = {
      override_list: 'WHITE_LIST',
      override_type: 'SHA256',
      sha256_hash: HASH,
      description: 'vendor allow',
    }
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', name: KEY, existed: true, id: 'ov-1', prior: original },
    ]
    const live = {
      id: 'ov-1',
      override_list: 'BLACK_LIST',
      override_type: 'SHA256',
      sha256_hash: HASH,
      filename: 'bad.exe',
      description: 'edited out of band',
    }
    await withFetch([searchPage([live]), cbJson({}), cbJson({ id: 'ov-3' })], async () => {
      const result = await deploy(ctx([BAN], { priorEntries: prior }))

      expect(result.success).toBe(true)
      // Re-snapshotting here would bake this app's own last deploy in as the
      // "original" and rollback would never reach the customer's real state.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: KEY, existed: true, id: 'ov-3', prior: original },
      ])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the create', async () => {
    await withFetch([EMPTY_SEARCH, cbError('override quota exceeded', 400)], async () => {
      const result = await deploy(ctx([BAN]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('Bad exe: override quota exceeded')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('does not create a duplicate when the delete half of a replace fails', async () => {
    const live = {
      id: 'ov-1',
      override_list: 'WHITE_LIST',
      override_type: 'SHA256',
      sha256_hash: HASH,
    }
    await withFetch([searchPage([live]), cbError('override is locked', 409)], async (calls) => {
      const result = await deploy(ctx([BAN]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('override is locked')
      // Posting after a failed delete would leave two rows for one hash.
      expect(writes(calls)).toHaveLength(1)
      expect(writes(calls)[0].method).toBe('DELETE')
      expect(entries(result)).toEqual([])
    })
  })

  it('stops at the listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([BAN]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list reputation overrides/)
      expect(result.message).toContain('forbidden')
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deletes an override it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: `sha256:${'bb'.repeat(32)}`, existed: false, id: 'ov-old' }]
    await withFetch([EMPTY_SEARCH, cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${OVERRIDES}/ov-old`)
    })
  })

  it('never deletes an override it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: `sha256:${'bb'.repeat(32)}`, existed: true, id: 'ov-them' }]
    await withFetch([EMPTY_SEARCH], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([EMPTY_SEARCH, cbJson({ id: 'ov-new' })], async () => {
      const result = await deploy(ctx([BAN], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([EMPTY_SEARCH, cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([BAN]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
