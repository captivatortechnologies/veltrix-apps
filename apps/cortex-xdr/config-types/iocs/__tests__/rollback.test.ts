import rollback from '../rollback'
import { IOC_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'iocs'
const INSERT = IOC_ENDPOINTS.insert
const DELETE = IOC_ENDPOINTS.delete

const BAD_IP = '203.0.113.7'

const LIVE_IOC = {
  indicator: BAD_IP,
  type: 'IP',
  severity: 'LOW',
  reputation: 'SUSPICIOUS',
  reliability: 'D',
  comment: 'set by the previous owner',
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  { fields: { indicator: BAD_IP, type: 'IP', severity: 'CRITICAL', reputation: 'BAD' } },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr iocs rollback handler', () => {
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
        ctx({ previous: [{ indicator: BAD_IP, prior: LIVE_IOC }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('re-inserts the LIVE prior indicator body, not the canvas values', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(ctx({ previous: [{ indicator: BAD_IP, prior: LIVE_IOC }] }))

      const restored = callsTo(calls, INSERT)
      expect(restored).toHaveLength(1)
      // The severity the console had (LOW), not the CRITICAL the canvas wanted.
      expect(requestArray(restored[0])).toEqual([LIVE_IOC])
      expect(callsTo(calls, DELETE)).toHaveLength(0)
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('restores every prior indicator in one bulk insert', async () => {
    const second = { indicator: 'evil.example', type: 'DOMAIN_NAME', severity: 'HIGH' }
    await withFetch([cortexReply({})], async (calls) => {
      await rollback(
        ctx({
          previous: [
            { indicator: BAD_IP, prior: LIVE_IOC },
            { indicator: 'evil.example', prior: second },
          ],
        }),
      )

      expect(callsTo(calls, INSERT)).toHaveLength(1)
      expect(requestArray(callsTo(calls, INSERT)[0])).toEqual([LIVE_IOC, second])
    })
  })

  it('deletes the indicators this deploy created, by value, in one call', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { indicator: BAD_IP, prior: null },
            { indicator: 'evil.example', prior: null },
          ],
        }),
      )

      const deleted = callsTo(calls, DELETE)
      expect(deleted).toHaveLength(1)
      expect(requestData(deleted[0])).toEqual({ indicators: [BAD_IP, 'evil.example'] })
      expect(result.message).toMatch(/0 restored, 2 deleted/)
    })
  })

  it('restores what existed before removing what it created', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { indicator: 'evil.example', prior: null },
            { indicator: BAD_IP, prior: LIVE_IOC },
          ],
        }),
      )

      expect(calls[0].apiPath).toBe(INSERT)
      expect(calls[1].apiPath).toBe(DELETE)
      expect(result.message).toMatch(/1 restored, 1 deleted/)
    })
  })

  it('reports the vendor reason when the restore is rejected, and does not go on to delete', async () => {
    await withFetch([cortexError('indicator rejected', 400)], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { indicator: BAD_IP, prior: LIVE_IOC },
            { indicator: 'evil.example', prior: null },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(result.message).toMatch(/indicator rejected/)
      expect(callsTo(calls, DELETE)).toHaveLength(0)
    })
  })

  it('reports the vendor reason when the delete is rejected', async () => {
    await withFetch([cortexError('unknown indicator', 404)], async () => {
      const result = await rollback(ctx({ previous: [{ indicator: BAD_IP, prior: null }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback delete failed/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(ctx({ previous: [{ indicator: BAD_IP, prior: null }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([cortexError('forbidden', 403)], async () => {
      const result = await rollback(ctx({ previous: [{ indicator: BAD_IP, prior: null }] }))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
