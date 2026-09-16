import driftDetect from '../driftDetect'
import {
  ACTION_CENTER_EXPIRATION_GET_PATH,
  SCALAR_SETTING_GROUPS,
  type ScalarSettingGroup,
} from '../_shared'
import {
  type CannedResponse,
  type ItemInput,
  cortexError,
  cortexReply,
  driftContext,
  mentionsApiKey,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'agent-configuration-settings'
const CONTENT = SCALAR_SETTING_GROUPS[0]

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

/** Every key this config type manages, given an explicit value on the canvas. */
const FIELDS: Record<string, unknown> = {
  enable_bandwidth_control: true,
  enable_minor_content_version_updates: false,
  bandwidth_in_mbps: 500,
  license_revocation_after_lost_connection: 45,
  agent_deletion_retention: 200,
  amount_of_parallel_upgrades: 10,
  enable_wildfire_analysis_scoring_for_benign_verdicts: true,
  display_unique_and_informative_btp_rules: true,
  allow_logs_collection: false,
  enabled_critical_environment_versions: true,
  automatically_upload_defined_issue_data_files: true,
  automatically_apply_advanced_analysis_exceptions: false,
  periodic_duplicate_cleanup: true,
  host_name: true,
  ip: false,
  mac: false,
  time_interval_hours: 6,
}

/** The live tenant, group by group, agreeing with FIELDS on every key. */
const LIVE_IN_SYNC: Array<Record<string, unknown>> = [
  { enable_bandwidth_control: true, enable_minor_content_version_updates: false, bandwidth_in_mbps: 500 },
  { license_revocation_after_lost_connection: 45, agent_deletion_retention: 200 },
  { amount_of_parallel_upgrades: 10 },
  { enable_wildfire_analysis_scoring_for_benign_verdicts: true },
  { display_unique_and_informative_btp_rules: true },
  { allow_logs_collection: false },
  { enabled_critical_environment_versions: true },
  {
    automatically_upload_defined_issue_data_files: true,
    automatically_apply_advanced_analysis_exceptions: false,
  },
  { periodic_duplicate_cleanup: true, host_name: true, ip: false, mac: false, time_interval_hours: 6 },
]

/** One canned GET reply per scalar group, with `overrides` merged onto one of them. */
function liveGroups(
  overrides: Partial<Record<string, unknown>> = {},
  groupIndex = 0,
): CannedResponse[] {
  return LIVE_IN_SYNC.map((group, index) =>
    cortexReply(index === groupIndex ? { ...group, ...overrides } : group),
  )
}

/** A group's GET reply replaced by a failure. */
function liveGroupsWithFailure(groupIndex: number, group: ScalarSettingGroup): CannedResponse[] {
  return LIVE_IN_SYNC.map((live, index) =>
    index === groupIndex ? cortexError(`cannot read ${group.key}`, 403) : cortexReply(live),
  )
}

const ITEM: ItemInput = { name: 'Agent settings', fields: FIELDS }

describe('cortex-xdr agent-configuration-settings driftDetect handler', () => {
  it('asserts no drift and makes no call when there is no credential', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([ITEM], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('asserts no drift and makes no call when the canvas holds no settings item', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([]))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('asserts no drift and makes no call when the connection has no tenant FQDN', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([ITEM], { noHostname: true }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads every setting group once and reports no drift when they all agree', async () => {
    await withFetch(liveGroups(), async (calls) => {
      const result = await driftDetect(ctx([ITEM]))

      expect(calls).toHaveLength(SCALAR_SETTING_GROUPS.length)
      expect(calls[0].apiPath).toBe(CONTENT.getPath)
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('flags a boolean someone flipped in the console', async () => {
    await withFetch(liveGroups({ enable_bandwidth_control: false }), async () => {
      const result = await driftDetect(ctx([ITEM]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('content_management.enable_bandwidth_control')
      expect(result.diffs[0].expected).toBe(true)
      expect(result.diffs[0].actual).toBe(false)
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('flags an integer limit that was changed', async () => {
    await withFetch(liveGroups({ bandwidth_in_mbps: 50 }), async () => {
      const result = await driftDetect(ctx([ITEM]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('content_management.bandwidth_in_mbps')
      expect(result.diffs[0].expected).toBe(500)
      expect(result.diffs[0].actual).toBe(50)
    })
  })

  it('flags log collection being switched off, whichever group it sits in', async () => {
    await withFetch(liveGroups({ allow_logs_collection: true }, 5), async () => {
      const result = await driftDetect(ctx([ITEM]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cortex_xdr_log_collection.allow_logs_collection')
    })
  })

  it('skips a group it cannot read rather than raising drift on every key in it', async () => {
    await withFetch(liveGroupsWithFailure(0, CONTENT), async (calls) => {
      const result = await driftDetect(ctx([ITEM]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      // It still reads every other group rather than giving up entirely.
      expect(calls).toHaveLength(SCALAR_SETTING_GROUPS.length)
    })
  })

  it('compares only the action-center keys the canvas declares', async () => {
    const responses = liveGroups()
    responses.push(cortexReply({ isolate: 24, scan: 6, file_retrieval: 999 }))

    await withFetch(responses, async (calls) => {
      const result = await driftDetect(
        ctx([{ fields: { ...FIELDS, action_center_expiration: { isolate: 12, scan: 6 } } }]),
      )

      expect(calls).toHaveLength(SCALAR_SETTING_GROUPS.length + 1)
      expect(calls[calls.length - 1].apiPath).toBe(ACTION_CENTER_EXPIRATION_GET_PATH)
      // file_retrieval is wildly different and is still not reported: the canvas
      // does not manage it.
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('action_center_expiration.isolate')
      expect(result.diffs[0].expected).toBe(12)
      expect(result.diffs[0].actual).toBe(24)
    })
  })

  it('makes no action-center call when the canvas declares none', async () => {
    await withFetch(liveGroups(), async (calls) => {
      await driftDetect(ctx([ITEM]))

      expect(calls).toHaveLength(SCALAR_SETTING_GROUPS.length)
    })
  })

  it('asserts no drift rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('EAI_AGAIN', async () => {
      const result = await driftDetect(ctx([ITEM]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('keeps the API key out of every diff it reports', async () => {
    await withFetch(liveGroups({ enable_bandwidth_control: false }), async () => {
      const result = await driftDetect(ctx([ITEM]))

      expect(result.hasDrift).toBe(true)
      expect(mentionsApiKey(result.diffs)).toBe(false)
    })
  })
})
