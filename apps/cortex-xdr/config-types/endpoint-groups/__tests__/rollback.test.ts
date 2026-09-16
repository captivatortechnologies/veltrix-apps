import rollback from '../rollback'
import { ENDPOINT_GROUP_ENDPOINTS } from '../_shared'
import {
  API_KEY,
  callsTo,
  cortexError,
  cortexReply,
  mentionsApiKey,
  requestData,
  rollbackContext,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'endpoint-groups'
const CREATE = ENDPOINT_GROUP_ENDPOINTS.create
const DELETE = ENDPOINT_GROUP_ENDPOINTS.delete

/** The prior LIVE snapshot deploy captured — what a restore must replay verbatim. */
const LIVE_WORKSTATIONS = {
  name: 'Workstations',
  description: 'live description set in the console',
  group_type: 'static',
  group_id: 77,
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  { fields: { name: 'Workstations', description: 'what the canvas wanted', group_type: 'dynamic' } },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr endpoint-groups rollback handler', () => {
  it('does nothing when the deploy recorded no prior state', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ previous: [] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Nothing to roll back/)
      expect(calls).toHaveLength(0)
    })
  })

  it('does nothing when there is no rollback data at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses without a credential instead of calling the tenant', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Workstations', prior: LIVE_WORKSTATIONS }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior body it was handed, not the canvas values', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Workstations', prior: LIVE_WORKSTATIONS }] }),
      )

      const restored = callsTo(calls, CREATE)
      expect(restored).toHaveLength(1)
      // Verbatim: the console's own state, down to its group_id.
      expect(requestData(restored[0])).toEqual(LIVE_WORKSTATIONS)
      expect(callsTo(calls, DELETE)).toHaveLength(0)
      expect(result.success).toBe(true)
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('deletes by name a group this deploy created', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'Servers', prior: null }] }))

      const deleted = callsTo(calls, DELETE)
      expect(deleted).toHaveLength(1)
      expect(requestData(deleted[0])).toEqual({ name: 'Servers' })
      expect(callsTo(calls, CREATE)).toHaveLength(0)
      expect(result.message).toMatch(/0 restored, 1 deleted/)
    })
  })

  it('restores what existed before removing what it created', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'Servers', prior: null },
            { name: 'Workstations', prior: LIVE_WORKSTATIONS },
          ],
        }),
      )

      // Restores first: a delete that runs first would briefly leave the tenant
      // with neither the prior group nor the created one.
      expect(calls[0].apiPath).toBe(CREATE)
      expect(calls[1].apiPath).toBe(DELETE)
      expect(result.message).toMatch(/1 restored, 1 deleted/)
    })
  })

  it('reports the vendor reason when a restore is rejected', async () => {
    await withFetch([cortexError('group name already in use', 409)], async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Workstations', prior: LIVE_WORKSTATIONS }] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(result.message).toMatch(/group name already in use/)
    })
  })

  it('reports the vendor reason when a delete is rejected', async () => {
    await withFetch([cortexError('no such endpoint', 404)], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'Servers', prior: null }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback delete failed/)
      expect(result.message).toMatch(/no such endpoint/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(ctx({ previous: [{ name: 'Servers', prior: null }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([cortexError(`rejected key ${API_KEY.slice(0, 4)}…`, 403)], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'Servers', prior: null }] }))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
