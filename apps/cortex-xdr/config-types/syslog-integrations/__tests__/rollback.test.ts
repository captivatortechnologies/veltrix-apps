import rollback from '../rollback'
import { SYSLOG_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'syslog-integrations'
const UPDATE = SYSLOG_ENDPOINTS.update
const DELETE = SYSLOG_ENDPOINTS.delete

const LIVE_INTEGRATION = {
  SYSLOG_INTEGRATION_ID: 31,
  SYSLOG_INTEGRATION_NAME: 'SOC collector',
  SYSLOG_INTEGRATION_ADDRESS: 'old-collector.internal',
  SYSLOG_INTEGRATION_PORT: 514,
  SYSLOG_INTEGRATION_PROTOCOL: 'UDP',
  FACILITY: 'LOCAL0',
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  { fields: { name: 'SOC collector', address: 'collector.internal', port: 6514, protocol: 'TLS' } },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr syslog-integrations rollback handler', () => {
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
        ctx({ previous: [{ name: 'SOC collector', prior: LIVE_INTEGRATION }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior destination, mapping the read keys back onto the write ones', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'SOC collector', prior: LIVE_INTEGRATION }] }),
      )

      const updated = callsTo(calls, UPDATE)
      expect(updated).toHaveLength(1)
      expect(requestData(updated[0])).toEqual({
        syslog_id: '31',
        // The destination the tenant was really forwarding to, not the canvas's.
        name: 'SOC collector',
        address: 'old-collector.internal',
        port: 514,
        protocol: 'UDP',
        facility: 'LOCAL0',
      })
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('says plainly that it could not restore the write-only certificate content', async () => {
    // The prior snapshot came from a read that never returns certificate_content,
    // so a TLS cert changed by the deploy stays changed — and is reported.
    await withFetch([cortexReply({})], async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'SOC collector', prior: LIVE_INTEGRATION }] }),
      )

      expect(result.message).toMatch(/TLS certificate content could not be restored/)
    })
  })

  it('does not mention the certificate caveat when nothing was restored', async () => {
    await withFetch([cortexReply({})], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'New collector', prior: null }] }))

      expect(result.message).toMatch(/0 restored, 1 deleted/)
      expect(result.message.includes('TLS certificate')).toBe(false)
    })
  })

  it('deletes each created integration with its own name filter', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New A', prior: null },
            { name: 'New B', prior: null },
          ],
        }),
      )

      const deleted = callsTo(calls, DELETE)
      // The documented filter shape takes one value per call, so each name gets one.
      expect(deleted).toHaveLength(2)
      expect(requestData(deleted[0])).toEqual({
        filters: [{ field: 'name', operator: 'eq', value: 'New A' }],
      })
      expect(requestData(deleted[1])).toEqual({
        filters: [{ field: 'name', operator: 'eq', value: 'New B' }],
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
            { name: 'SOC collector', prior: LIVE_INTEGRATION },
          ],
        }),
      )

      expect(calls[0].apiPath).toBe(UPDATE)
      expect(calls[1].apiPath).toBe(DELETE)
      expect(result.message).toMatch(/1 restored, 1 deleted/)
    })
  })

  it('reports the vendor reason when a restore is rejected, and does not go on to delete', async () => {
    await withFetch([cortexError('syslog_id not found', 404)], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'SOC collector', prior: LIVE_INTEGRATION },
            { name: 'New A', prior: null },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(callsTo(calls, DELETE)).toHaveLength(0)
    })
  })

  it('names the integration it could not delete when a later delete is rejected', async () => {
    await withFetch([cortexReply({}), cortexError('integration in use', 409)], async () => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New A', prior: null },
            { name: 'New B', prior: null },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback delete failed for "New B"/)
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
