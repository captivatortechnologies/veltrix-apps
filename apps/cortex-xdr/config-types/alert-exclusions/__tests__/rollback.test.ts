import rollback from '../rollback'
import { ALERT_EXCLUSION_ENDPOINTS } from '../_shared'
import {
  callsTo,
  cortexError,
  cortexReply,
  mentionsApiKey,
  requestData,
  rollbackContext,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'alert-exclusions'
const CREATE = ALERT_EXCLUSION_ENDPOINTS.create
const DELETE = ALERT_EXCLUSION_ENDPOINTS.delete

const LIVE_EXCLUSION = {
  name: 'Suppress backup agent',
  comment: 'raised by the backup team',
  disabled: false,
  filter: { field: 'process', value: 'backup.exe' },
  rule_id: 'exc-9',
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  { fields: { name: 'Suppress backup agent', comment: 'what the canvas wanted', disabled: true } },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr alert-exclusions rollback handler', () => {
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
        ctx({ previous: [{ name: 'Suppress backup agent', prior: LIVE_EXCLUSION }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior body it was handed, not the canvas values', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Suppress backup agent', prior: LIVE_EXCLUSION }] }),
      )

      expect(requestData(callsTo(calls, CREATE)[0])).toEqual(LIVE_EXCLUSION)
      expect(callsTo(calls, DELETE)).toHaveLength(0)
      expect(result.success).toBe(true)
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('deletes by name an exclusion this deploy created', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'New rule', prior: null }] }))

      expect(requestData(callsTo(calls, DELETE)[0])).toEqual({ name: 'New rule' })
      expect(callsTo(calls, CREATE)).toHaveLength(0)
      expect(result.message).toMatch(/0 restored, 1 deleted/)
    })
  })

  it('restores what existed before removing what it created', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New rule', prior: null },
            { name: 'Suppress backup agent', prior: LIVE_EXCLUSION },
          ],
        }),
      )

      expect(calls[0].apiPath).toBe(CREATE)
      expect(calls[1].apiPath).toBe(DELETE)
      expect(result.message).toMatch(/1 restored, 1 deleted/)
    })
  })

  it('reports the vendor reason when a restore is rejected', async () => {
    await withFetch([cortexError('exclusion name already in use', 409)], async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Suppress backup agent', prior: LIVE_EXCLUSION }] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(result.message).toMatch(/already in use/)
    })
  })

  it('reports the vendor reason when a delete is rejected', async () => {
    await withFetch([cortexError('no such endpoint', 404)], async () => {
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
