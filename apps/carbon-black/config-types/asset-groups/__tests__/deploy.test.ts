import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_BASE_URL_SETTINGS,
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

const CONFIG_TYPE = 'asset-groups'
const GROUPS = `/asset_groups/v1/orgs/${ORG_KEY}/groups`

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function group(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

const SPEC = group({
  name: 'Windows Servers',
  description: 'prod windows',
  memberType: 'DEVICE',
  query: 'os.equals:WINDOWS',
  policyId: '42',
})

const LIVE = {
  id: 'ag-1',
  name: 'Windows Servers',
  description: 'old description',
  member_type: 'DEVICE',
  query: 'os.equals:LINUX',
  policy_id: 7,
  status: 'OK',
}

describe('carbon-black asset-groups deploy handler', () => {
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

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SPEC], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'ag-new' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].path).toBe(GROUPS)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates a group that does not exist yet and records it as app-created', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'ag-new' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(GROUPS)
      expect(objectBody(posted[0])).toEqual({
        name: 'Windows Servers',
        description: 'prod windows',
        member_type: 'DEVICE',
        query: 'os.equals:WINDOWS',
        policy_id: 42,
      })
      // `existed: false` is what tells rollback this group is ours to delete.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: 'Windows Servers', existed: false, id: 'ag-new' },
      ])
    })
  })

  it('omits query and policy_id entirely when the group declares neither', async () => {
    const bare = group({ name: 'Unfiltered', description: 'placeholder', memberType: 'DEVICE' })
    await withFetch([EMPTY_LIST, cbJson({ id: 'ag-bare' })], async (calls) => {
      const result = await deploy(ctx([bare]))

      expect(result.success).toBe(true)
      expect(objectBody(writes(calls)[0])).toEqual({
        name: 'Unfiltered',
        description: 'placeholder',
        member_type: 'DEVICE',
      })
    })
  })

  it('updates a group that already exists and records its prior state, not the desired one', async () => {
    await withFetch([cbJson({ results: [LIVE] }), cbJson({ id: 'ag-1' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(`${GROUPS}/ag-1`)
      expect(objectBody(put[0]).query).toBe('os.equals:WINDOWS')

      // The snapshot rollback restores must be the LIVE values, not the spec's.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: 'Windows Servers',
          existed: true,
          id: 'ag-1',
          prior: {
            name: 'Windows Servers',
            description: 'old description',
            member_type: 'DEVICE',
            query: 'os.equals:LINUX',
            policy_id: 7,
          },
        },
      ])
    })
  })

  it('carries the original pre-management snapshot forward on a second deploy', async () => {
    const original = {
      name: 'Windows Servers',
      description: 'old description',
      member_type: 'DEVICE',
      query: 'os.equals:LINUX',
      policy_id: 7,
    }
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', name: 'Windows Servers', existed: true, id: 'ag-1', prior: original },
    ]
    // The live group now holds what the FIRST deploy wrote; re-snapshotting it
    // would lose the only copy of the customer's own configuration.
    const managed = { ...LIVE, description: 'prod windows', query: 'os.equals:WINDOWS', policy_id: 42 }
    await withFetch([cbJson({ results: [managed] }), cbJson({ id: 'ag-1' })], async () => {
      const result = await deploy(ctx([SPEC], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].prior).toEqual(original)
      expect(entries(result)[0].existed).toBe(true)
    })
  })

  it('updates a renamed group in place by its recorded id rather than recreating it', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-1', name: 'Old Name', existed: false, id: 'ag-1' }]
    const renamed = group({ name: 'New Name', description: 'prod windows', memberType: 'DEVICE', query: 'os.equals:WINDOWS' })
    await withFetch([cbJson({ results: [{ ...LIVE, name: 'Old Name' }] }), cbJson({ id: 'ag-1' })], async (calls) => {
      const result = await deploy(ctx([renamed], { priorEntries: prior }))

      expect(result.success).toBe(true)
      // One PUT and no reconcile DELETE — the old name is gone but the id is kept.
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(`${GROUPS}/ag-1`)
      expect(objectBody(put[0]).name).toBe('New Name')
      // App-created stays app-created across the rename.
      expect(entries(result)[0].existed).toBe(false)
    })
  })

  it('matches the live group when the listing comes back as a bare array', async () => {
    await withFetch([cbJson([LIVE]), cbJson({ id: 'ag-1' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      expect(writes(calls)[0].method).toBe('PUT')
      expect(writes(calls)[0].path).toBe(`${GROUPS}/ag-1`)
    })
  })

  it('matches the live group when the listing comes back under a groups envelope', async () => {
    await withFetch([cbJson({ groups: [LIVE] }), cbJson({ id: 'ag-1' })], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(true)
      expect(writes(calls)[0].method).toBe('PUT')
      expect(writes(calls)[0].path).toBe(`${GROUPS}/ag-1`)
    })
  })

  it('reports failure rather than throwing when the vendor rejects the create', async () => {
    await withFetch([EMPTY_LIST, cbError('asset group limit reached', 400)], async () => {
      const result = await deploy(ctx([SPEC]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('asset group limit reached')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('stops at the listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([SPEC]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list asset groups/)
      expect(result.message).toContain('forbidden')
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deletes a group it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'Retired', existed: false, id: 'ag-old' }]
    await withFetch([EMPTY_LIST, cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${GROUPS}/ag-old`)
    })
  })

  it('treats an already-removed group as reconciled when cleaning up', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'Retired', existed: false, id: 'ag-old' }]
    await withFetch([EMPTY_LIST, cbNotFound()], async () => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
    })
  })

  it('never deletes a group it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: 'PreExisting', existed: true, id: 'ag-them' }]
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([EMPTY_LIST, cbJson({ id: 'ag-new' })], async () => {
      const result = await deploy(ctx([SPEC], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([EMPTY_LIST, cbError('unauthorized', 401)], async (calls) => {
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
