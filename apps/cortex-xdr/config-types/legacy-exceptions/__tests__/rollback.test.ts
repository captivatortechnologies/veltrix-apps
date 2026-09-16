import rollback from '../rollback'
import { LEGACY_EXCEPTION_ENDPOINTS } from '../_shared'
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

const CONFIG_TYPE = 'legacy-exceptions'
const EDIT = LEGACY_EXCEPTION_ENDPOINTS.edit
const DELETE = LEGACY_EXCEPTION_ENDPOINTS.delete

const LIVE_EXCEPTION = {
  id: 'exc-3311',
  rule_name: 'Allow backup agent',
  platform: 'windows',
  module: 12,
  status: 'disabled',
  scope: 'global',
  description: 'left disabled by the previous owner',
  conditions: { field: 'process_path', op: 'EQ', value: 'C:/old/agent.exe' },
  profile_ids: [7],
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  { fields: { name: 'Allow backup agent', status: 'enabled', platform: 'linux', module: 44 } },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr legacy-exceptions rollback handler', () => {
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
        ctx({ previous: [{ name: 'Allow backup agent', prior: LIVE_EXCEPTION }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior snapshot by exception_id, not the canvas values', async () => {
    await withFetch([cortexReply('ok')], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Allow backup agent', prior: LIVE_EXCEPTION }] }),
      )

      const edited = callsTo(calls, EDIT)
      expect(edited).toHaveLength(1)
      expect(requestData(edited[0])).toEqual({
        exception_id: 'exc-3311',
        update_data: {
          // The console's windows / disabled / module 12, not the canvas's
          // linux / enabled / module 44. rule_name maps back onto `name`.
          name: 'Allow backup agent',
          platform: 'windows',
          module: 12,
          profile_ids: [7],
          status: 'disabled',
          scope: 'global',
          description: 'left disabled by the previous owner',
          conditions: { field: 'process_path', op: 'EQ', value: 'C:/old/agent.exe' },
        },
      })
      expect(result.message).toMatch(/1 restored, 0 deleted/)
    })
  })

  it('sends an empty profile list rather than omitting it when the prior had none', async () => {
    const noProfiles = { ...LIVE_EXCEPTION, profile_ids: undefined }
    await withFetch([cortexReply('ok')], async (calls) => {
      await rollback(ctx({ previous: [{ name: 'Allow backup agent', prior: noProfiles }] }))

      const update = requestData(callsTo(calls, EDIT)[0]).update_data as Record<string, unknown>
      expect(update.profile_ids).toEqual([])
    })
  })

  it('deletes by the captured exception ids what this deploy created', async () => {
    await withFetch([cortexReply('ok')], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New A', prior: null, createdId: 'exc-1' },
            { name: 'New B', prior: null, createdId: 'exc-2' },
          ],
        }),
      )

      const deleted = callsTo(calls, DELETE)
      expect(deleted).toHaveLength(1)
      expect(requestData(deleted[0])).toEqual({ exception_ids: ['exc-1', 'exc-2'] })
      expect(result.message).toMatch(/0 restored, 2 deleted/)
    })
  })

  it('reports, rather than guesses at, an exception whose created id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'New A', prior: null }] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/1 newly-created exception\(s\) could not be auto-deleted/)
      expect(result.message).toMatch(/remove them manually/)
      // Nothing is deleted on a guess.
      expect(calls).toHaveLength(0)
    })
  })

  it('restores what existed before removing what it created', async () => {
    await withFetch([cortexReply('ok'), cortexReply('ok')], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'New A', prior: null, createdId: 'exc-1' },
            { name: 'Allow backup agent', prior: LIVE_EXCEPTION },
          ],
        }),
      )

      expect(calls[0].apiPath).toBe(EDIT)
      expect(calls[1].apiPath).toBe(DELETE)
      expect(result.message).toMatch(/1 restored, 1 deleted/)
    })
  })

  it('reports the vendor reason when a restore is rejected, and does not go on to delete', async () => {
    await withFetch([cortexError('exception_id not found', 404)], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'Allow backup agent', prior: LIVE_EXCEPTION },
            { name: 'New A', prior: null, createdId: 'exc-1' },
          ],
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(callsTo(calls, DELETE)).toHaveLength(0)
    })
  })

  it('reports the vendor reason when the delete is rejected', async () => {
    await withFetch([cortexError('exception in use', 409)], async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'New A', prior: null, createdId: 'exc-1' }] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback delete failed/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'New A', prior: null, createdId: 'exc-1' }] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([cortexError('forbidden', 403)], async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'New A', prior: null, createdId: 'exc-1' }] }),
      )

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
