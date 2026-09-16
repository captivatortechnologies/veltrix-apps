import rollback from '../rollback'
import { CORRELATION_ENDPOINTS } from '../_shared'
import {
  callsTo,
  cortexError,
  cortexReply,
  mentionsApiKey,
  requestArray,
  requestData,
  rollbackContext,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'correlation-rules'
const INSERT = CORRELATION_ENDPOINTS.insert
const DELETE = CORRELATION_ENDPOINTS.delete

const LIVE_RULE = {
  rule_id: 909,
  name: 'Credential dumping',
  severity: 'SEV_020_LOW',
  xql_query: 'dataset = xdr_data | filter false',
  is_enabled: false,
  execution_mode: 'SCHEDULED',
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  { fields: { name: 'Credential dumping', severity: 'SEV_040_HIGH', execution_mode: 'REAL_TIME' } },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr correlation-rules rollback handler', () => {
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
        ctx({ previous: [{ name: 'Credential dumping', prior: LIVE_RULE }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior rule body, carrying its rule_id so it updates in place', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'Credential dumping', prior: LIVE_RULE }] }))

      const sent = requestArray(callsTo(calls, INSERT)[0])
      // The console's own query and severity, not the canvas's.
      expect(sent).toEqual([LIVE_RULE])
      expect(callsTo(calls, DELETE)).toHaveLength(0)
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('deletes rules this deploy created with one name filter', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'New A', prior: null }, { name: 'New B', prior: null }] }),
      )

      expect(requestData(callsTo(calls, DELETE)[0])).toEqual({
        filters: [{ field: 'name', operator: 'IN', value: ['New A', 'New B'] }],
      })
      expect(result.message).toMatch(/0 restored, 2 deleted/)
    })
  })

  it('restores what existed before removing what it created', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New A', prior: null },
            { name: 'Credential dumping', prior: LIVE_RULE },
          ],
        }),
      )

      expect(calls[0].apiPath).toBe(INSERT)
      expect(calls[1].apiPath).toBe(DELETE)
      expect(result.message).toMatch(/1 restored, 1 deleted/)
    })
  })

  it('reports the vendor reason when the restore is rejected, and does not go on to delete', async () => {
    await withFetch([cortexError('rule_id not found', 404)], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'Credential dumping', prior: LIVE_RULE },
            { name: 'New A', prior: null },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(callsTo(calls, DELETE)).toHaveLength(0)
    })
  })

  it('reports the vendor reason when the delete is rejected', async () => {
    await withFetch([cortexError('filter not supported', 400)], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'New A', prior: null }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback delete failed/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(ctx({ previous: [{ name: 'New A', prior: null }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([cortexError('forbidden', 403)], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'New A', prior: null }] }))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
