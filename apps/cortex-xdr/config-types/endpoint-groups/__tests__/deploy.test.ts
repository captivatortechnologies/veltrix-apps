import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { ENDPOINT_GROUP_ENDPOINTS } from '../_shared'
import {
  API_KEY,
  API_KEY_ID,
  EMPTY_REPLY,
  type ItemInput,
  callsTo,
  cortexError,
  cortexReply,
  deployContext,
  mentionsApiKey,
  requestData,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'endpoint-groups'
const LIST = ENDPOINT_GROUP_ENDPOINTS.list
const CREATE = ENDPOINT_GROUP_ENDPOINTS.create

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function item(fields: Record<string, unknown>): ItemInput {
  return { fields }
}

interface PriorEntry {
  name: string
  prior: Record<string, unknown> | null
}

/** The `previous` list deploy records for rollback — the only thing rollback can act on. */
function previousOf(result: DeployResult): PriorEntry[] {
  const data = result.rollbackData as { previous?: PriorEntry[] } | undefined
  return data?.previous ?? []
}

/** A group as Cortex hands it back from get_endpoint_groups — the LIVE state. */
const LIVE_WORKSTATIONS = {
  name: 'Workstations',
  description: 'live description set in the console',
  group_type: 'static',
  group_id: 77,
}

describe('cortex-xdr endpoint-groups deploy handler', () => {
  it('refuses without a credential instead of calling the tenant', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([item({ name: 'Workstations' })], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the connection carries no tenant API FQDN', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([item({ name: 'Workstations' })], { noHostname: true }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/FQDN/)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the live groups before it writes, with the API key headers on the first call', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(ctx([item({ name: 'Workstations', group_type: 'static' })]))

      expect(calls[0].apiPath).toBe(LIST)
      expect(calls[0].method).toBe('POST')
      // Cortex Standard security: the key id, and the key itself sent verbatim.
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
      expect(calls[1].apiPath).toBe(CREATE)
      expect(calls[1].authorization).toBe(API_KEY)
    })
  })

  it('creates a group that does not exist yet and records no prior state', async () => {
    await withFetch([cortexReply({ groups: [] }), cortexReply({})], async (calls) => {
      const result = await deploy(
        ctx([item({ name: 'Servers', group_type: 'static', description: 'prod servers' })]),
      )

      const created = callsTo(calls, CREATE)
      expect(created).toHaveLength(1)
      expect(requestData(created[0])).toEqual({
        name: 'Servers',
        group_type: 'static',
        description: 'prod servers',
      })
      expect(result.success).toBe(true)
      expect(result.artifacts?.applied).toEqual(['Servers'])
      // prior null is what tells rollback "we created this — delete it".
      expect(previousOf(result)).toEqual([{ name: 'Servers', prior: null }])
    })
  })

  it('records the LIVE prior body of an existing group, not the canvas values', async () => {
    await withFetch(
      [cortexReply({ groups: [LIVE_WORKSTATIONS] }), cortexReply({})],
      async () => {
        const result = await deploy(
          ctx([
            item({
              name: 'workstations',
              group_type: 'dynamic',
              description: 'the description the canvas wants',
            }),
          ]),
        )

        expect(result.success).toBe(true)
        // Matched case-insensitively, and the snapshot is what Cortex returned —
        // rollback must restore the console's state, not replay the canvas.
        expect(previousOf(result)).toEqual([{ name: 'workstations', prior: LIVE_WORKSTATIONS }])
      },
    )
  })

  it('parses a JSON filter into the request body rather than sending the raw string', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      await deploy(
        ctx([item({ name: 'Laptops', group_type: 'dynamic', filter: '{"os":"WINDOWS"}' })]),
      )

      expect(requestData(callsTo(calls, CREATE)[0]).filter).toEqual({ os: 'WINDOWS' })
    })
  })

  it('skips a canvas item with no name instead of writing a nameless group', async () => {
    await withFetch([EMPTY_REPLY, cortexReply({})], async (calls) => {
      const result = await deploy(ctx([item({ name: '   ' }), item({ name: 'Servers' })]))

      const created = callsTo(calls, CREATE)
      expect(created).toHaveLength(1)
      expect(requestData(created[0]).name).toBe('Servers')
      expect(result.artifacts?.applied).toEqual(['Servers'])
    })
  })

  it('reports the vendor reason and stops at the first rejected group', async () => {
    await withFetch(
      [EMPTY_REPLY, cortexReply({}), cortexError('endpoint not found', 404)],
      async (calls) => {
        const result = await deploy(ctx([item({ name: 'First' }), item({ name: 'Second' })]))

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Second/)
        expect(result.message).toMatch(/endpoint not found/)
        // What already landed is reported, so the operator knows the half-applied state.
        expect(result.artifacts?.applied).toEqual(['First'])
        expect(previousOf(result)).toHaveLength(2)
        // Nothing is attempted after the failure.
        expect(callsTo(calls, CREATE)).toHaveLength(2)
      },
    )
  })

  it('returns a failed result rather than throwing on an unparseable filter', async () => {
    await withFetch([EMPTY_REPLY], async () => {
      const result = await deploy(ctx([item({ name: 'Laptops', filter: '{not json' })]))

      // A throw surfaces as an opaque pipeline crash; the contract is a result.
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/failed/i)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ETIMEDOUT', async () => {
      const result = await deploy(ctx([item({ name: 'Workstations' })]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ETIMEDOUT/)
    })
  })

  it('keeps the API key out of the message, artifacts and rollback state', async () => {
    await withFetch([EMPTY_REPLY, cortexError('invalid API key', 401)], async () => {
      const result = await deploy(ctx([item({ name: 'Workstations' })]))

      expect(result.success).toBe(false)

      expect(mentionsApiKey(result.message)).toBe(false)
      expect(mentionsApiKey(result.artifacts)).toBe(false)
      expect(mentionsApiKey(result.rollbackData)).toBe(false)
    })
  })
})
