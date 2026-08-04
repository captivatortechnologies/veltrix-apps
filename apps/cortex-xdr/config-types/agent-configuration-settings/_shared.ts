// Shared helpers for the Cortex XDR Agent Configuration Settings config type
// (deploy + rollback + drift).
//
// CONFIRMED public write path (re-verified 2026-08 against the "Cortex Platform"
// docs, Agent Configuration Settings tag) — a tenant-wide SINGLETON of 9 small
// GET/SET setting groups under /public_api/v1/configurations/agent/*, plus one
// partial-merge keyvalue map (action_center_expiration). Unlike most config
// types in this app, there is no per-item identity to reconcile — each setting
// group is a standalone toggle/limit for the whole tenant, and this config type
// "owns" every scalar group outright (every deploy re-applies the full declared
// value, the same policy apps/auth0's tenant-settings config type uses for its
// tenant-wide singleton), except `action_center_expiration`, which is a genuine
// partial merge — only the action-type keys present in the canvas map are ever
// touched (see buildActionCenterExpiration below).
//
// VERIFY every endpoint path, field name and accepted value range against a
// live Cortex XDR tenant.

import { readBoolean, readOptionalInt, readKeyValueMap } from '../../lib/fields'

/** One GET/SET boolean+integer setting group. `booleanKeys` default false; `intKeys` fall back to their canvas default. */
export interface ScalarSettingGroup {
  key: string
  getPath: string
  setPath: string
  booleanKeys: string[]
  intKeys: string[]
}

export const SCALAR_SETTING_GROUPS: ScalarSettingGroup[] = [
  {
    key: 'content_management',
    getPath: '/configurations/agent/content_management/',
    setPath: '/configurations/agent/content_management/set/',
    booleanKeys: ['enable_bandwidth_control', 'enable_minor_content_version_updates'],
    intKeys: ['bandwidth_in_mbps'],
  },
  {
    key: 'agent_status',
    getPath: '/configurations/agent/agent_status/',
    setPath: '/configurations/agent/agent_status/set/',
    booleanKeys: [],
    intKeys: ['license_revocation_after_lost_connection', 'agent_deletion_retention'],
  },
  {
    key: 'auto_upgrade',
    getPath: '/configurations/agent/auto_upgrade/',
    setPath: '/configurations/agent/auto_upgrade/set/',
    booleanKeys: [],
    intKeys: ['amount_of_parallel_upgrades'],
  },
  {
    key: 'wildfire_analysis',
    getPath: '/configurations/agent/wildfire_analysis/',
    setPath: '/configurations/agent/wildfire_analysis/set/',
    booleanKeys: ['enable_wildfire_analysis_scoring_for_benign_verdicts'],
    intKeys: [],
  },
  {
    key: 'informative_btp_issues',
    getPath: '/configurations/agent/informative_btp_issues/',
    setPath: '/configurations/agent/informative_btp_issues/set/',
    booleanKeys: ['display_unique_and_informative_btp_rules'],
    intKeys: [],
  },
  {
    key: 'cortex_xdr_log_collection',
    getPath: '/configurations/agent/cortex_xdr_log_collection/',
    setPath: '/configurations/agent/cortex_xdr_log_collection/set/',
    booleanKeys: ['allow_logs_collection'],
    intKeys: [],
  },
  {
    key: 'critical_environment_versions',
    getPath: '/configurations/agent/critical_environment_versions/',
    setPath: '/configurations/agent/critical_environment_versions/set/',
    booleanKeys: ['enabled_critical_environment_versions'],
    intKeys: [],
  },
  {
    key: 'advanced_analysis',
    getPath: '/configurations/agent/advanced_analysis/',
    setPath: '/configurations/agent/advanced_analysis/set/',
    booleanKeys: ['automatically_upload_defined_issue_data_files', 'automatically_apply_advanced_analysis_exceptions'],
    intKeys: [],
  },
  {
    key: 'endpoint_administration_cleanup',
    getPath: '/configurations/agent/endpoint_administration_cleanup/',
    setPath: '/configurations/agent/endpoint_administration_cleanup/set/',
    booleanKeys: ['periodic_duplicate_cleanup', 'host_name', 'ip', 'mac'],
    intKeys: ['time_interval_hours'],
  },
]

/** action_center_expiration is a genuine partial-merge keyvalue map (action type -> hours). */
export const ACTION_CENTER_EXPIRATION_GET_PATH = '/configurations/agent/action_center_expiration/'
export const ACTION_CENTER_EXPIRATION_SET_PATH = '/configurations/agent/action_center_expiration/set/'

/** Canvas defaults, used when a field is blank (matches Cortex's own documented defaults where known). */
export const FIELD_DEFAULTS: Record<string, number> = {
  bandwidth_in_mbps: 1000,
  license_revocation_after_lost_connection: 30,
  agent_deletion_retention: 180,
  amount_of_parallel_upgrades: 20,
  time_interval_hours: 24,
}

/** Documented enum for endpoint_administration_cleanup.time_interval_hours. */
export const TIME_INTERVAL_HOURS_OPTIONS = new Set([1, 6, 24, 168])

/** Build a group's SET request_data from canvas fields — every boolean/int key is always included ("owns it outright"). */
export function buildScalarGroupRequest(group: ScalarSettingGroup, fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of group.booleanKeys) {
    body[key] = readBoolean(fields[key], false)
  }
  for (const key of group.intKeys) {
    body[key] = readOptionalInt(fields[key]) ?? FIELD_DEFAULTS[key] ?? 0
  }
  return body
}

/** Extract a group's comparable fields from its GET reply (which is the flat settings object, e.g. { enabled_critical_environment_versions: true }). */
export function scalarGroupFromReply(reply: unknown): Record<string, unknown> {
  if (reply && typeof reply === 'object') return reply as Record<string, unknown>
  return {}
}

/** Parse the action_center_expiration keyvalue map to { actionType: hours }; non-positive-integer values are dropped (validate.ts rejects them). */
export function parseActionCenterExpiration(value: unknown): Record<string, number> {
  const raw = readKeyValueMap(value)
  const out: Record<string, number> = {}
  for (const [key, v] of Object.entries(raw)) {
    const n = readOptionalInt(v)
    if (n !== undefined && n > 0) out[key] = n
  }
  return out
}
