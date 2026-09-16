import rollback from '../rollback'
import { EXTERNAL_APPLICATION_BASE } from '../_shared'
import {
  NO_CONTENT,
  callsToPath,
  mentionsApiKey,
  objectBody,
  platformError,
  platformJson,
  rollbackContext,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'external-applications'
const BASE = EXTERNAL_APPLICATION_BASE

const LIVE_APP = {
  application_id: 88,
  name: 'SOC webhook',
  description: 'set by the previous owner',
  application_type: 'webhook',
  connection_config: { url: 'https://hooks.example/old' },
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  {
    fields: {
      name: 'SOC webhook',
      description: 'managed by Veltrix',
      connection_config: '{"url":"https://hooks.example/soc"}',
    },
  },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr external-applications rollback handler', () => {
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
        ctx({ previous: [{ name: 'SOC webhook', prior: LIVE_APP }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior snapshot by PUT to its id path, not the canvas values', async () => {
    await withFetch([platformJson({ data: {} })], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'SOC webhook', prior: LIVE_APP }] }))

      const restored = callsToPath(calls, `${BASE}/88`)
      expect(restored).toHaveLength(1)
      expect(restored[0].method).toBe('PUT')
      expect(objectBody(restored[0])).toEqual({
        name: 'SOC webhook',
        description: 'set by the previous owner',
        application_type: 'webhook',
        // The endpoint the tenant was really forwarding to.
        connection_config: { url: 'https://hooks.example/old' },
      })
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('sends an empty connection_config rather than omitting it when the prior had none', async () => {
    await withFetch([platformJson({ data: {} })], async (calls) => {
      const { connection_config: _dropped, ...noConfig } = LIVE_APP
      await rollback(ctx({ previous: [{ name: 'SOC webhook', prior: noConfig }] }))

      expect(objectBody(calls[0]).connection_config).toEqual({})
    })
  })

  it('deletes a created application through its type-and-id path', async () => {
    await withFetch([NO_CONTENT], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New hook', prior: null, created: { application_id: 101, application_type: 'webhook' } },
          ],
        }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${BASE}/webhook/id/101`)
      expect(result.message).toMatch(/0 restored, 1 deleted/)
    })
  })

  it('reports, rather than guesses at, an application whose created id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'New hook', prior: null }] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/1 newly-created application\(s\) could not be auto-deleted/)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores what existed before removing what it created', async () => {
    await withFetch([platformJson({ data: {} }), NO_CONTENT], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New hook', prior: null, created: { application_id: 101, application_type: 'webhook' } },
            { name: 'SOC webhook', prior: LIVE_APP },
          ],
        }),
      )

      expect(calls[0].method).toBe('PUT')
      expect(calls[1].method).toBe('DELETE')
      expect(result.message).toMatch(/1 restored, 1 deleted/)
    })
  })

  it('reports the vendor reason when a restore is rejected, and does not go on to delete', async () => {
    await withFetch([platformError('application not found', 404)], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'SOC webhook', prior: LIVE_APP },
            { name: 'New hook', prior: null, created: { application_id: 101, application_type: 'webhook' } },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(result.message).toMatch(/application not found/)
      expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    })
  })

  it('reports the vendor reason when a delete is rejected', async () => {
    await withFetch([platformError('application is referenced by a rule', 409)], async () => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New hook', prior: null, created: { application_id: 101, application_type: 'webhook' } },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback delete failed/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(ctx({ previous: [{ name: 'SOC webhook', prior: LIVE_APP }] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([platformError('forbidden', 403)], async () => {
      const result = await rollback(ctx({ previous: [{ name: 'SOC webhook', prior: LIVE_APP }] }))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
