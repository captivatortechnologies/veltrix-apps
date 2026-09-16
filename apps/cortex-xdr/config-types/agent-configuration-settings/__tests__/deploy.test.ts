import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import {
  ACTION_CENTER_EXPIRATION_GET_PATH,
  ACTION_CENTER_EXPIRATION_SET_PATH,
  SCALAR_SETTING_GROUPS,
} from '../_shared'
import {
  API_KEY,
  API_KEY_ID,
  type ItemInput,
  callsTo,
  cortexError,
  cortexReply,
  deployContext,
  mentionsApiKey,
  requestData,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'agent-configuration-settings'
const CONTENT = SCALAR_SETTING_GROUPS[0]
const CLEANUP = SCALAR_SETTING_GROUPS[8]
/** Nine GET/SET pairs, one per scalar setting group. */
const SCALAR_CALLS = SCALAR_SETTING_GROUPS.length * 2

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

interface RollbackShape {
  priorByGroup?: Record<string, Record<string, unknown> | null>
  touchedActionKeys?: string[]
  priorActionValues?: Record<string, number>
}

function rollbackOf(result: DeployResult): RollbackShape {
  return (result.rollbackData ?? {}) as RollbackShape
}

const FIELDS: Record<string, unknown> = {
  enable_bandwidth_control: true,
  enable_minor_content_version_updates: false,
  bandwidth_in_mbps: 500,
  periodic_duplicate_cleanup: true,
  host_name: true,
  time_interval_hours: 6,
}

const SETTINGS_ITEM: ItemInput = { name: 'Agent settings', fields: FIELDS }

describe('cortex-xdr agent-configuration-settings deploy handler', () => {
  it('does nothing, and calls nothing, when the canvas holds no settings item', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/No agent configuration settings configured/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses without a credential instead of calling the tenant', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SETTINGS_ITEM], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the connection carries no tenant API FQDN', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SETTINGS_ITEM], { noHostname: true }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/FQDN/)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads each setting group before it writes it, and carries the API key headers', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SETTINGS_ITEM]))

      expect(calls).toHaveLength(SCALAR_CALLS)
      expect(calls[0].apiPath).toBe(CONTENT.getPath)
      expect(calls[1].apiPath).toBe(CONTENT.setPath)
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
      // The read must come first, or there is no prior value to restore.
      for (let i = 0; i < SCALAR_SETTING_GROUPS.length; i++) {
        expect(calls[i * 2].apiPath).toBe(SCALAR_SETTING_GROUPS[i].getPath)
        expect(calls[i * 2 + 1].apiPath).toBe(SCALAR_SETTING_GROUPS[i].setPath)
      }
      expect(result.success).toBe(true)
    })
  })

  it('sends every key of a group it owns, so an unchecked box cannot mean "leave it alone"', async () => {
    await withFetch([], async (calls) => {
      await deploy(ctx([SETTINGS_ITEM]))

      expect(requestData(callsTo(calls, CONTENT.setPath)[0])).toEqual({
        enable_bandwidth_control: true,
        enable_minor_content_version_updates: false,
        bandwidth_in_mbps: 500,
      })
      // `ip` and `mac` were never authored, and are still sent as explicit false.
      expect(requestData(callsTo(calls, CLEANUP.setPath)[0])).toEqual({
        periodic_duplicate_cleanup: true,
        host_name: true,
        ip: false,
        mac: false,
        time_interval_hours: 6,
      })
    })
  })

  it('falls back to Cortex documented defaults for an integer the canvas left blank', async () => {
    await withFetch([], async (calls) => {
      await deploy(ctx([{ fields: {} }]))

      expect(requestData(callsTo(calls, CONTENT.setPath)[0]).bandwidth_in_mbps).toBe(1000)
      expect(requestData(callsTo(calls, CLEANUP.setPath)[0]).time_interval_hours).toBe(24)
    })
  })

  it('records each group prior GET response, which is all rollback has to restore', async () => {
    await withFetch(
      [cortexReply({ enable_bandwidth_control: false, bandwidth_in_mbps: 100 })],
      async () => {
        const result = await deploy(ctx([SETTINGS_ITEM]))

        expect(rollbackOf(result).priorByGroup?.content_management).toEqual({
          enable_bandwidth_control: false,
          bandwidth_in_mbps: 100,
        })
      },
    )
  })

  it('records null for a group whose prior value could not be read, rather than a guess', async () => {
    // Rollback skips a null group instead of writing an invented "prior" over
    // whatever the tenant actually has.
    await withFetch([cortexError('not permitted for this key', 403)], async () => {
      const result = await deploy(ctx([SETTINGS_ITEM]))

      expect(rollbackOf(result).priorByGroup?.content_management).toBeNull()
      expect(result.success).toBe(true)
    })
  })

  it('touches only the action-center keys the canvas declares, and records their prior values', async () => {
    const priorMap = cortexReply({ isolate: 24, scan: 48, file_retrieval: 72 })
    const responses = new Array(SCALAR_CALLS).fill(cortexReply({}))
    responses.push(priorMap)

    await withFetch(responses, async (calls) => {
      const result = await deploy(
        ctx([{ fields: { ...FIELDS, action_center_expiration: { isolate: 12, scan: 6 } } }]),
      )

      const set = callsTo(calls, ACTION_CENTER_EXPIRATION_SET_PATH)
      expect(set).toHaveLength(1)
      // file_retrieval is never mentioned — a partial merge, not a replace.
      expect(requestData(set[0])).toEqual({ isolate: 12, scan: 6 })
      expect(callsTo(calls, ACTION_CENTER_EXPIRATION_GET_PATH)).toHaveLength(1)
      expect(rollbackOf(result).touchedActionKeys).toEqual(['isolate', 'scan'])
      expect(rollbackOf(result).priorActionValues).toEqual({ isolate: 24, scan: 48 })
      expect(result.artifacts?.applied).toContain('action_center_expiration')
    })
  })

  it('makes no action-center call at all when the canvas declares none', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([SETTINGS_ITEM]))

      expect(callsTo(calls, ACTION_CENTER_EXPIRATION_GET_PATH)).toHaveLength(0)
      expect(callsTo(calls, ACTION_CENTER_EXPIRATION_SET_PATH)).toHaveLength(0)
      expect(rollbackOf(result).touchedActionKeys).toEqual([])
    })
  })

  it('drops a non-positive action-center value rather than sending it', async () => {
    await withFetch([], async (calls) => {
      await deploy(ctx([{ fields: { ...FIELDS, action_center_expiration: { isolate: 0, scan: 6 } } }]))

      expect(requestData(callsTo(calls, ACTION_CENTER_EXPIRATION_SET_PATH)[0])).toEqual({ scan: 6 })
    })
  })

  it('reports the vendor reason and stops at the first rejected group', async () => {
    await withFetch(
      [cortexReply({}), cortexError('bandwidth_in_mbps out of range', 400)],
      async (calls) => {
        const result = await deploy(ctx([SETTINGS_ITEM]))

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/content_management/)
        expect(result.message).toMatch(/bandwidth_in_mbps out of range/)
        expect(result.artifacts?.applied).toEqual([])
        // Nothing past the failing group is attempted.
        expect(calls).toHaveLength(2)
      },
    )
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ETIMEDOUT', async () => {
      const result = await deploy(ctx([SETTINGS_ITEM]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ETIMEDOUT/)
    })
  })

  it('keeps the API key out of the message, artifacts and rollback state', async () => {
    await withFetch([cortexReply({}), cortexError('invalid API key', 401)], async () => {
      const result = await deploy(ctx([SETTINGS_ITEM]))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
      expect(mentionsApiKey(result.artifacts)).toBe(false)
      expect(mentionsApiKey(result.rollbackData)).toBe(false)
    })
  })
})
