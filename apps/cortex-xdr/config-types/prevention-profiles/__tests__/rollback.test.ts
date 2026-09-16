import rollback from '../rollback'
import { PREVENTION_PROFILE_ENDPOINTS } from '../_shared'
import {
  callsTo,
  cortexError,
  cortexReply,
  mentionsApiKey,
  objectBody,
  rollbackContext,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'prevention-profiles'
const EDIT = PREVENTION_PROFILE_ENDPOINTS.edit

const LIVE_PROFILE = {
  id: 55,
  name: 'Servers hardened',
  type: 'prevention',
  is_default: false,
  description: 'set by the previous owner',
  modules: { anti_ransomware: { action: 'report' } },
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  {
    fields: {
      name: 'Servers hardened',
      description: 'managed by Veltrix',
      modules: '{"anti_ransomware":{"action":"block"}}',
    },
  },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr prevention-profiles rollback handler', () => {
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
        ctx({ previous: [{ name: 'Servers hardened', prior: LIVE_PROFILE }] }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the LIVE prior modules with a RAW body, not the canvas values', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Servers hardened', prior: LIVE_PROFILE }] }),
      )

      const edited = callsTo(calls, EDIT)
      expect(edited).toHaveLength(1)
      expect(objectBody(edited[0])).toEqual({
        profile_id: 55,
        update_data: {
          name: 'Servers hardened',
          description: 'set by the previous owner',
          // The protection that was actually in force (report), not the block
          // the canvas asked for.
          modules: { anti_ransomware: { action: 'report' } },
        },
      })
      expect(objectBody(edited[0]).request_data).toBeUndefined()
      expect(result.message).toMatch(/1 restored/)
    })
  })

  it('leaves a default profile alone, since Cortex forbids editing one', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Default', prior: { ...LIVE_PROFILE, is_default: true } }] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports, rather than silently pretends, that a created profile cannot be removed', async () => {
    // There is no documented delete endpoint for prevention profiles, so a
    // newly-created one is left in place and named.
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ previous: [{ name: 'New profile', prior: null }] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/1 newly-created profile\(s\) could not be removed/)
      expect(result.message).toMatch(/no delete endpoint/)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores what it can and still reports what it could not remove', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          previous: [
            { name: 'Servers hardened', prior: LIVE_PROFILE },
            { name: 'New profile', prior: null },
          ],
        }),
      )

      expect(callsTo(calls, EDIT)).toHaveLength(1)
      expect(result.message).toMatch(/1 restored/)
      expect(result.message).toMatch(/could not be removed/)
    })
  })

  it('reports the vendor reason when a restore is rejected', async () => {
    await withFetch([cortexError('profile_id not found', 404)], async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Servers hardened', prior: LIVE_PROFILE }] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback restore failed/)
      expect(result.message).toMatch(/profile_id not found/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Servers hardened', prior: LIVE_PROFILE }] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([cortexError('forbidden', 403)], async () => {
      const result = await rollback(
        ctx({ previous: [{ name: 'Servers hardened', prior: LIVE_PROFILE }] }),
      )

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
