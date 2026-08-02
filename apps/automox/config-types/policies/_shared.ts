// Shared helpers for the Automox Policies config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Policies (this config type) always write `policy_type_name: "patch"` — a
// Worklet (custom) or Required Software policy is a DIFFERENT config type
// (`../worklets`) so the two never race to reconcile the same underlying
// `/policies` object by name (see ../lib/automoxPolicies.findPolicyByName's
// `expectedType` narrowing).
//
// VERIFIED against the official OpenAPI description published in the Automox
// Console Python SDK (swagger-codegen, MIT license):
//   https://github.com/AutomoxCommunity/automox-console-sdk-python/blob/main/specs/ax_console.yaml
// and cross-checked against the community Automox MCP server's live-tested
// policy workflow (Apache-2.0), which documents several behaviors the OpenAPI
// spec does not:
//   https://github.com/AutomoxCommunity/automox-mcp/blob/main/src/automox_mcp/workflows/policy_crud.py

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import {
  extractPolicyCommonFields,
  buildPolicyEnvelope,
  parseDeviceFilters,
  type PolicyCommonFields,
} from '../lib/automoxPolicies'
import { readBool, strList, str } from '../lib/canvasValues'

export const PATCH_RULES = ['all', 'filter', 'manual', 'advanced'] as const
export const FILTER_TYPES = ['include', 'exclude', 'severity'] as const

/**
 * Severities accepted by `configuration.severity_filter` on a Patch-by-Severity
 * policy (`patch_rule: filter`, `filter_type: severity`). The published OpenAPI
 * excerpt's enum omits `no_known_cves`; the automox-mcp source (comment citing
 * "Automox Console API.json" lines 107160-107168, verified against a live
 * create-probe) documents the fuller set used here.
 */
export const SEVERITY_FILTERS = ['no_known_cves', 'none', 'unknown', 'low', 'medium', 'high', 'critical'] as const

/** The desired state for one patch Policy, extracted from a canvas item. */
export interface PolicySpec extends PolicyCommonFields {
  patchRule: string
  filterType: string
  filters: string[]
  severityFilter: string[]
  autoPatch: boolean
  autoReboot: boolean
  notifyUser: boolean
  notifyRebootUser: boolean
  includeOptional: boolean
  missedPatchWindow: boolean
  deviceFiltersRaw: string
}

/** Each canvas item describes one Automox patch Policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      ...extractPolicyCommonFields(item),
      patchRule: str(fields.patch_rule) || 'all',
      filterType: str(fields.filter_type) || 'include',
      filters: strList(fields.filters),
      severityFilter: strList(fields.severity_filter),
      autoPatch: readBool(fields.auto_patch, true),
      autoReboot: readBool(fields.auto_reboot, true),
      notifyUser: readBool(fields.notify_user, true),
      notifyRebootUser: readBool(fields.notify_reboot_user, true),
      includeOptional: readBool(fields.include_optional, false),
      missedPatchWindow: readBool(fields.missed_patch_window, false),
      deviceFiltersRaw: typeof fields.device_filters_json === 'string' ? fields.device_filters_json.trim() : '',
    }
  })
}

export interface BuiltConfiguration {
  configuration: Record<string, unknown>
  error?: string
}

/**
 * Build `configuration` for a patch policy (`PatchPolicyConfiguration` /
 * `PatchFilterPolicyConfiguration`). Two live-API behaviors verified via the
 * automox-mcp workflow (not documented in the OpenAPI spec) are applied
 * unconditionally so a create/update never 400s on them:
 *   - `filter_type` is REQUIRED on every patch policy regardless of
 *     `patch_rule` (Automox issue #206) — forced to "all" for non-filter rules.
 *   - `device_filters_enabled` must be explicitly `true` for a supplied
 *     `device_filters` list to take effect — the API silently ignores it
 *     otherwise.
 */
export function buildPatchConfiguration(spec: PolicySpec): BuiltConfiguration {
  const configuration: Record<string, unknown> = {
    auto_patch: spec.autoPatch,
    auto_reboot: spec.autoReboot,
    notify_user: spec.notifyUser,
    notify_reboot_user: spec.notifyRebootUser,
    include_optional: spec.includeOptional,
    missed_patch_window: spec.missedPatchWindow,
    patch_rule: spec.patchRule,
  }

  if (spec.patchRule === 'filter') {
    if (spec.filterType === 'severity') {
      if (spec.severityFilter.length === 0) {
        return { configuration, error: 'Patch Rule "filter" with Filter Type "severity" requires at least one severity.' }
      }
      configuration.filter_type = 'severity'
      configuration.severity_filter = spec.severityFilter
    } else {
      if (spec.filters.length === 0) {
        return {
          configuration,
          error: 'Patch Rule "filter" with Filter Type "include"/"exclude" requires at least one filter pattern.',
        }
      }
      configuration.filter_type = spec.filterType || 'include'
      configuration.filters = spec.filters
    }
  } else {
    // Non-filter rules (all/manual/advanced): filter_type is still required by
    // the live API (issue #206) but meaningless without `filters` — force "all".
    configuration.filter_type = 'all'
  }

  const deviceFilters = parseDeviceFilters(spec.deviceFiltersRaw)
  if (deviceFilters.error) return { configuration, error: deviceFilters.error }
  configuration.device_filters = deviceFilters.filters
  configuration.device_filters_enabled = deviceFilters.filters.length > 0

  return { configuration }
}

export interface BuiltPolicyBody {
  body: Record<string, unknown>
  error?: string
}

/** Build the full Automox policy body (policy_type_name: "patch") for POST/PUT /policies. */
export function buildPolicyBody(spec: PolicySpec, organizationId: number): BuiltPolicyBody {
  const built = buildPatchConfiguration(spec)
  if (built.error) return { body: {}, error: built.error }
  return { body: buildPolicyEnvelope(spec, 'patch', organizationId, built.configuration) }
}
