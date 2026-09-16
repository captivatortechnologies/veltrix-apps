import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  arrayBody,
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

const CONFIG_TYPE = 'device-control-blocks'
const BLOCKS = `/device_control/v3/orgs/${ORG_KEY}/blocks`
const POLICY_SUMMARY = `/policyservice/v1/orgs/${ORG_KEY}/policies/summary`

/** The policy-name -> id lookup every deploy does before it can address a block. */
const POLICIES = cbJson({
  policies: [
    { id: 101, name: 'Standard' },
    { id: 202, name: 'Restricted' },
  ],
})

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function block(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.policyName ?? ''), fields }
}

const STANDARD = block({ policyName: 'Standard', allowWrite: true, allowExecute: false })

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

describe('carbon-black device-control-blocks deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([STANDARD], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([STANDARD], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([STANDARD], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the policy summary and the live blocks, in that order, before writing anything', async () => {
    await withFetch([POLICIES, EMPTY_LIST, cbJson({ results: [{ id: 'blk-new', policy_id: 101 }] })], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(POLICY_SUMMARY)
      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe(BLOCKS)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('stops at the policy-summary failure without even listing the blocks', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list policies/)
      expect(result.message).toContain('forbidden')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('stops at the block-listing failure rather than writing against an unknown live state', async () => {
    await withFetch([POLICIES, cbError('service unavailable', 503)], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list device-control blocks/)
      expect(result.message).toContain('service unavailable')
      expect(calls).toHaveLength(2)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('fails the deploy when a policy name cannot be resolved instead of skipping it quietly', async () => {
    await withFetch([POLICIES, EMPTY_LIST], async (calls) => {
      const result = await deploy(ctx([block({ policyName: 'Retired Policy', allowWrite: true })]))

      // Silently dropping the item would leave the operator believing the block landed.
      expect(result.success).toBe(false)
      expect(result.message).toContain('Retired Policy: policy not found')
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([])
    })
  })

  it('creates a block that does not exist yet through a single bulk POST', async () => {
    await withFetch([POLICIES, EMPTY_LIST, cbJson({ results: [{ id: 'blk-new', policy_id: 101 }] })], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('Deployed 1 device-control block(s)')
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(`${BLOCKS}/_bulk`)
      // The bulk endpoint takes an ARRAY of block bodies, not a single object.
      expect(arrayBody(posted[0])).toEqual([
        { policy_id: '101', windows: { approved_devices: { allow_write: true, allow_execute: false } } },
      ])
      // The entry is keyed by the RESOLVED policy id, not the policy name.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: '101', existed: false, id: 'blk-new' },
      ])
    })
  })

  it('records an id-less entry when the bulk response never echoes the policy back', async () => {
    await withFetch([POLICIES, EMPTY_LIST, cbJson({ results: [] })], async () => {
      const result = await deploy(ctx([STANDARD]))

      // The create succeeded as far as the handler knows, so the deploy passes —
      // but with no id the entry is one rollback can never undo.
      expect(result.success).toBe(true)
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: '101', existed: false, id: undefined },
      ])
    })
  })

  it('updates a block that already exists and records its prior state, not the desired one', async () => {
    const live = {
      id: 'blk-1',
      policy_id: 101,
      windows: { approved_devices: { allow_write: false, allow_execute: false } },
    }
    await withFetch([POLICIES, cbJson({ results: [live] }), cbJson({})], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(`${BLOCKS}/blk-1`)
      expect(objectBody(put[0])).toEqual({
        policy_id: '101',
        windows: { approved_devices: { allow_write: true, allow_execute: false } },
      })

      // The snapshot rollback restores must be the LIVE values, not the spec's.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: '101',
          existed: true,
          id: 'blk-1',
          prior: { policy_id: 101, windows: { approved_devices: { allow_write: false, allow_execute: false } } },
        },
      ])
    })
  })

  it('updates the matched block and batches every new one into one bulk POST', async () => {
    const live = {
      id: 'blk-1',
      policy_id: 101,
      windows: { approved_devices: { allow_write: false, allow_execute: false } },
    }
    const restricted = block({ policyName: 'Restricted', allowWrite: false, allowExecute: true })

    await withFetch(
      [POLICIES, cbJson({ results: [live] }), cbJson({}), cbJson({ results: [{ id: 'blk-r', policy_id: 202 }] })],
      async (calls) => {
        const result = await deploy(ctx([STANDARD, restricted]))

        expect(result.success).toBe(true)
        const sent = writes(calls)
        expect(sent).toHaveLength(2)
        expect(sent[0].method).toBe('PUT')
        expect(sent[0].path).toBe(`${BLOCKS}/blk-1`)
        expect(sent[1].method).toBe('POST')
        expect(sent[1].path).toBe(`${BLOCKS}/_bulk`)
        expect(arrayBody(sent[1])).toEqual([
          { policy_id: '202', windows: { approved_devices: { allow_write: false, allow_execute: true } } },
        ])
        expect(entries(result)).toHaveLength(2)
        expect(entries(result)[1]).toEqual({ itemId: 'item-2', name: '202', existed: false, id: 'blk-r' })
      },
    )
  })

  it('writes nothing when the live block already matches the spec', async () => {
    const live = {
      id: 'blk-1',
      policy_id: 101,
      windows: { approved_devices: { allow_write: true, allow_execute: false } },
    }
    await withFetch([POLICIES, cbJson({ results: [live] })], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].existed).toBe(true)
      expect(entries(result)[0].id).toBe('blk-1')
    })
  })

  it('carries the original pre-management snapshot forward across a second deploy', async () => {
    const original = { policy_id: 101, windows: { approved_devices: { allow_write: false, allow_execute: true } } }
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', name: '101', existed: true, id: 'blk-1', prior: original },
    ]
    // The live block now carries the state the FIRST deploy wrote.
    const live = {
      id: 'blk-1',
      policy_id: 101,
      windows: { approved_devices: { allow_write: false, allow_execute: false } },
    }
    await withFetch([POLICIES, cbJson({ results: [live] }), cbJson({})], async () => {
      const result = await deploy(ctx([STANDARD], { priorEntries: prior }))

      expect(result.success).toBe(true)
      // Overwriting `prior` with the now-managed state would make rollback a no-op.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: '101', existed: true, id: 'blk-1', prior: original },
      ])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the bulk create', async () => {
    await withFetch([POLICIES, EMPTY_LIST, cbError('device control is not licensed for this org', 400)], async () => {
      const result = await deploy(ctx([STANDARD]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('bulk create')
      expect(result.message).toContain('device control is not licensed for this org')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('reports failure naming the policy when the vendor rejects an update', async () => {
    const live = { id: 'blk-1', policy_id: 101, windows: { approved_devices: { allow_write: false } } }
    await withFetch([POLICIES, cbJson({ results: [live] }), cbError('block is managed elsewhere', 409)], async () => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('Standard: block is managed elsewhere')
      // A rejected update leaves no entry — there is nothing for rollback to undo.
      expect(entries(result)).toEqual([])
    })
  })

  it('deletes a block it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: '999', existed: false, id: 'blk-old' }]
    await withFetch([POLICIES, EMPTY_LIST, cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${BLOCKS}/blk-old`)
    })
  })

  it('never deletes a block it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: '999', existed: true, id: 'blk-theirs' }]
    await withFetch([POLICIES, EMPTY_LIST], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('treats an already-gone block as reconciled when cleaning up', async () => {
    const prior: RollbackEntry[] = [{ itemId: 'item-9', name: '999', existed: false, id: 'blk-old' }]
    await withFetch([POLICIES, EMPTY_LIST, cbNotFound()], async () => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([POLICIES, EMPTY_LIST, cbJson({ results: [{ id: 'blk-new', policy_id: 101 }] })], async () => {
      const result = await deploy(ctx([STANDARD], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([POLICIES, EMPTY_LIST, cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([STANDARD]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
