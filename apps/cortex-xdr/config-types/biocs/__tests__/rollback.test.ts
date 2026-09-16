import rollback from '../rollback'
import { BIOC_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'biocs'
const INSERT = BIOC_ENDPOINTS.insert
const DELETE = BIOC_ENDPOINTS.delete

const LIVE_BIOC = {
  rule_id: 4210,
  name: 'LSASS handle access',
  type: 'CREDENTIAL_ACCESS',
  severity: 'SEV_020_LOW',
  status: 'disabled',
  comment: 'muted last quarter',
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  { fields: { name: 'LSASS handle access', severity: 'SEV_040_HIGH', status: 'enabled' } },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr biocs rollback handler', () => {
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
        ctx({ previous: [{ name: 'LSASS handle access', prior: LIVE_BIOC }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior rule body, carrying its rule_id so it updates in place', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'LSASS handle access', prior: LIVE_BIOC }] }),
      )

      const sent = requestArray(callsTo(calls, INSERT)[0])
      // The console's SEV_020_LOW / disabled, not the canvas's SEV_040_HIGH.
      expect(sent).toEqual([LIVE_BIOC])
      expect(sent[0].rule_id).toBe(4210)
      expect(callsTo(calls, DELETE)).toHaveLength(0)
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('deletes rules this deploy created with one name filter', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New rule A', prior: null },
            { name: 'New rule B', prior: null },
          ],
        }),
      )

      const deleted = callsTo(calls, DELETE)
      expect(deleted).toHaveLength(1)
      expect(requestData(deleted[0])).toEqual({
        filters: [{ field: 'name', operator: 'IN', value: ['New rule A', 'New rule B'] }],
      })
      expect(result.message).toMatch(/0 restored, 2 deleted/)
    })
  })

  it('restores what existed before removing what it created', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New rule', prior: null },
            { name: 'LSASS handle access', prior: LIVE_BIOC },
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
            { name: 'LSASS handle access', prior: LIVE_BIOC },
            { name: 'New rule', prior: null },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(result.message).toMatch(/rule_id not found/)
      expect(callsTo(calls, DELETE)).toHaveLength(0)
    })
  })

  it('reports the vendor reason when the delete is rejected', async () => {
    await withFetch([cortexError('filter not supported', 400)], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'New rule', prior: null }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback delete failed/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(ctx({ previous: [{ name: 'New rule', prior: null }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([cortexError('forbidden', 403)], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'New rule', prior: null }] }))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
