import rollback from '../rollback'
import { ACTION_CENTER_EXPIRATION_SET_PATH, SCALAR_SETTING_GROUPS } from '../_shared'
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

const CONFIG_TYPE = 'agent-configuration-settings'
const CONTENT = SCALAR_SETTING_GROUPS[0]
const AGENT_STATUS = SCALAR_SETTING_GROUPS[1]

/** What the tenant held before the deploy — the only thing a restore may replay. */
const PRIOR_CONTENT = {
  enable_bandwidth_control: false,
  enable_minor_content_version_updates: true,
  bandwidth_in_mbps: 100,
}

/** A canvas holding DIFFERENT values, so a restore that replays it is caught. */
const DESIRED_ITEMS = [
  { fields: { enable_bandwidth_control: true, bandwidth_in_mbps: 500 } },
]

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, items: DESIRED_ITEMS, ...opts })
}

describe('cortex-xdr agent-configuration-settings rollback handler', () => {
  it('does nothing when the deploy recorded no prior state', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ priorByGroup: {} }))

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
        ctx({ priorByGroup: { content_management: PRIOR_CONTENT } }, { credential: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('writes back the recorded prior values, not the canvas values', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(ctx({ priorByGroup: { content_management: PRIOR_CONTENT } }))

      const set = callsTo(calls, CONTENT.setPath)
      expect(set).toHaveLength(1)
      // The tenant's own 100 Mbps and disabled control, not the canvas's 500.
      expect(requestData(set[0])).toEqual(PRIOR_CONTENT)
      expect(result.success).toBe(true)
      expect(result.message).toMatch(/content_management/)
    })
  })

  it('skips a group whose prior value was never captured rather than writing a guess', async () => {
    // A null prior means the GET failed at deploy time; overwriting the group
    // with anything at all would be inventing a state the tenant never had.
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          priorByGroup: { content_management: null, agent_status: { agent_deletion_retention: 90 } },
        }),
      )

      expect(callsTo(calls, CONTENT.setPath)).toHaveLength(0)
      expect(callsTo(calls, AGENT_STATUS.setPath)).toHaveLength(1)
      expect(result.message).toMatch(/agent_status/)
    })
  })

  it('restores only the action-center keys the deploy actually touched', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          priorByGroup: { content_management: PRIOR_CONTENT },
          touchedActionKeys: ['isolate', 'scan'],
          priorActionValues: { isolate: 24, scan: 48, file_retrieval: 72 },
        }),
      )

      const set = callsTo(calls, ACTION_CENTER_EXPIRATION_SET_PATH)
      expect(set).toHaveLength(1)
      // file_retrieval was never touched, so it is never written back either.
      expect(requestData(set[0])).toEqual({ isolate: 24, scan: 48 })
      expect(result.message).toMatch(/action_center_expiration/)
    })
  })

  it('makes no action-center call when no prior value for a touched key was captured', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await rollback(
        ctx({
          priorByGroup: { content_management: PRIOR_CONTENT },
          touchedActionKeys: ['isolate'],
          priorActionValues: {},
        }),
      )

      expect(callsTo(calls, ACTION_CENTER_EXPIRATION_SET_PATH)).toHaveLength(0)
      expect(result.success).toBe(true)
    })
  })

  it('reports the group that failed when the tenant rejects a restore', async () => {
    await withFetch([cortexError('value out of range', 400)], async () => {
      const result = await rollback(ctx({ priorByGroup: { content_management: PRIOR_CONTENT } }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Rollback failed for "content_management"/)
      expect(result.message).toMatch(/value out of range/)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ECONNRESET', async () => {
      const result = await rollback(ctx({ priorByGroup: { content_management: PRIOR_CONTENT } }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ECONNRESET/)
    })
  })

  it('keeps the API key out of the failure message', async () => {
    await withFetch([cortexError('forbidden', 403)], async () => {
      const result = await rollback(ctx({ priorByGroup: { content_management: PRIOR_CONTENT } }))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
