import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  EMPTY_SEARCH,
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
  searchPage,
  withFetch,
  writes,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'device-control-approvals'
const APPROVALS = `/device_control/v3/orgs/${ORG_KEY}/approvals`

/** The device tuple is the natural key — this is the Sandisk stick's. */
const SANDISK_KEY = '0x0781|0x5581|sn1'

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function approval(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.approvalName ?? ''), fields }
}

const SANDISK = approval({
  approvalName: 'Sandisk Cruzer',
  notes: 'IT approved',
  vendorId: '0x0781',
  productId: '0x5581',
  serialNumber: 'SN1',
})

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

describe('carbon-black device-control-approvals deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SANDISK], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SANDISK], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SANDISK], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([EMPTY_SEARCH, cbJson({ results: [] })], async (calls) => {
      const result = await deploy(ctx([SANDISK]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      // The listing is a _search POST, so the very first call is already authenticated.
      expect(calls[0].path).toBe(`${APPROVALS}/_search`)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates an approval that does not exist yet through a single bulk POST', async () => {
    const created = { id: 'ap-new', vendor_id: '0x0781', product_id: '0x5581', serial_number: 'SN1' }
    await withFetch([EMPTY_SEARCH, cbJson({ results: [created] })], async (calls) => {
      const result = await deploy(ctx([SANDISK]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('Deployed 1 device-control approval(s)')
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      expect(posted[0].path).toBe(`${APPROVALS}/_bulk`)
      // The bulk endpoint takes an ARRAY of approval bodies, not a single object.
      expect(arrayBody(posted[0])).toEqual([
        {
          approval_name: 'Sandisk Cruzer',
          notes: 'IT approved',
          vendor_id: '0x0781',
          product_id: '0x5581',
          serial_number: 'SN1',
        },
      ])
      // `existed: false` is what tells rollback this approval is ours to delete.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: SANDISK_KEY, existed: false, id: 'ap-new' },
      ])
    })
  })

  it('records an id-less entry when the bulk response never echoes the device tuple back', async () => {
    await withFetch([EMPTY_SEARCH, cbJson({ results: [] })], async () => {
      const result = await deploy(ctx([SANDISK]))

      // The create succeeded as far as the handler knows, so the deploy passes —
      // but with no id the entry is one rollback can never undo.
      expect(result.success).toBe(true)
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: SANDISK_KEY, existed: false, id: undefined },
      ])
    })
  })

  it('updates an approval that already exists and records its prior state, not the desired one', async () => {
    const live = {
      id: 'ap-1',
      approval_name: 'Unnamed stick',
      notes: 'old notes',
      vendor_id: '0x0781',
      product_id: '0x5581',
      serial_number: 'SN1',
    }
    await withFetch([searchPage([live]), cbJson({ id: 'ap-1' })], async (calls) => {
      const result = await deploy(ctx([SANDISK]))

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(`${APPROVALS}/ap-1`)
      expect(objectBody(put[0])).toEqual({
        approval_name: 'Sandisk Cruzer',
        notes: 'IT approved',
        vendor_id: '0x0781',
        product_id: '0x5581',
        serial_number: 'SN1',
      })

      // The snapshot rollback restores must be the LIVE values, not the spec's.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: SANDISK_KEY,
          existed: true,
          id: 'ap-1',
          prior: {
            approval_name: 'Unnamed stick',
            notes: 'old notes',
            vendor_id: '0x0781',
            product_id: '0x5581',
            serial_number: 'SN1',
          },
        },
      ])
    })
  })

  it('updates the matched approvals and batches every new one into one bulk POST', async () => {
    const live = {
      id: 'ap-1',
      approval_name: 'Sandisk Cruzer',
      notes: 'old notes',
      vendor_id: '0x0781',
      product_id: '0x5581',
      serial_number: 'SN1',
    }
    const kingston = approval({ approvalName: 'Kingston', vendorId: '0x0951', productId: '0x1666' })
    const seagate = approval({ approvalName: 'Seagate', vendorId: '0x0bc2', productId: '0x2322' })
    const bulkResponse = cbJson({
      results: [
        { id: 'ap-k', vendor_id: '0x0951', product_id: '0x1666' },
        { id: 'ap-s', vendor_id: '0x0bc2', product_id: '0x2322' },
      ],
    })

    await withFetch([searchPage([live]), cbJson({}), bulkResponse], async (calls) => {
      const result = await deploy(ctx([SANDISK, kingston, seagate]))

      expect(result.success).toBe(true)
      const sent = writes(calls)
      expect(sent).toHaveLength(2)
      expect(sent[0].method).toBe('PUT')
      expect(sent[0].path).toBe(`${APPROVALS}/ap-1`)
      expect(sent[1].method).toBe('POST')
      expect(sent[1].path).toBe(`${APPROVALS}/_bulk`)
      // Both creations ride in ONE request — not one call per approval.
      expect(arrayBody(sent[1])).toHaveLength(2)
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          name: SANDISK_KEY,
          existed: true,
          id: 'ap-1',
          prior: {
            approval_name: 'Sandisk Cruzer',
            notes: 'old notes',
            vendor_id: '0x0781',
            product_id: '0x5581',
            serial_number: 'SN1',
          },
        },
        { itemId: 'item-2', name: '0x0951|0x1666|', existed: false, id: 'ap-k' },
        { itemId: 'item-3', name: '0x0bc2|0x2322|', existed: false, id: 'ap-s' },
      ])
    })
  })

  it('writes nothing when the live approval already matches the spec', async () => {
    const live = {
      id: 'ap-1',
      approval_name: 'Sandisk Cruzer',
      notes: 'IT approved',
      vendor_id: '0x0781',
      product_id: '0x5581',
      serial_number: 'SN1',
    }
    await withFetch([searchPage([live])], async (calls) => {
      const result = await deploy(ctx([SANDISK]))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].existed).toBe(true)
      expect(entries(result)[0].id).toBe('ap-1')
    })
  })

  it('carries the original pre-management snapshot forward across a second deploy', async () => {
    const original = {
      approval_name: 'Before Veltrix',
      notes: 'set by hand',
      vendor_id: '0x0781',
      product_id: '0x5581',
      serial_number: 'SN1',
    }
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', name: SANDISK_KEY, existed: true, id: 'ap-1', prior: original },
    ]
    // The live approval now carries the state the FIRST deploy wrote.
    const live = {
      id: 'ap-1',
      approval_name: 'Sandisk Cruzer',
      notes: 'managed by veltrix',
      vendor_id: '0x0781',
      product_id: '0x5581',
      serial_number: 'SN1',
    }
    await withFetch([searchPage([live]), cbJson({})], async () => {
      const result = await deploy(ctx([SANDISK], { priorEntries: prior }))

      expect(result.success).toBe(true)
      // Overwriting `prior` with the now-managed state would make rollback a no-op.
      expect(entries(result)).toEqual([
        { itemId: 'item-1', name: SANDISK_KEY, existed: true, id: 'ap-1', prior: original },
      ])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the bulk create', async () => {
    await withFetch([EMPTY_SEARCH, cbError('device control is not licensed for this org', 400)], async () => {
      const result = await deploy(ctx([SANDISK]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('bulk create')
      expect(result.message).toContain('device control is not licensed for this org')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('reports failure naming the approval when the vendor rejects an update', async () => {
    const live = { id: 'ap-1', approval_name: 'Old', vendor_id: '0x0781', product_id: '0x5581', serial_number: 'SN1' }
    await withFetch([searchPage([live]), cbError('approval is locked', 409)], async () => {
      const result = await deploy(ctx([SANDISK]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('Sandisk Cruzer: approval is locked')
      // A rejected update leaves no entry — there is nothing for rollback to undo.
      expect(entries(result)).toEqual([])
    })
  })

  it('stops at the listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([SANDISK]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list device-control approvals/)
      expect(result.message).toContain('forbidden')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deletes an approval it created before but no longer declares', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-9', name: '0x1111|0x2222|', existed: false, id: 'ap-old' },
    ]
    await withFetch([EMPTY_SEARCH, cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${APPROVALS}/ap-old`)
    })
  })

  it('never deletes an approval it merely adopted, even once undeclared', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-9', name: '0x1111|0x2222|', existed: true, id: 'ap-theirs' },
    ]
    await withFetch([EMPTY_SEARCH], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('treats an already-gone approval as reconciled when cleaning up', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-9', name: '0x1111|0x2222|', existed: false, id: 'ap-old' },
    ]
    await withFetch([EMPTY_SEARCH, cbNotFound()], async () => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch(
      [EMPTY_SEARCH, cbJson({ results: [{ id: 'ap-new', vendor_id: '0x0781', product_id: '0x5581', serial_number: 'SN1' }] })],
      async () => {
        const result = await deploy(ctx([SANDISK], { platformThrows: true }))

        expect(result.success).toBe(true)
        expect(entries(result)).toHaveLength(1)
      },
    )
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([EMPTY_SEARCH, cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([SANDISK]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
