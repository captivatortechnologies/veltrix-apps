// Shared helpers for the Automox Worklets config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// A "worklet" here is either an Automox `custom` (Worklet) policy or a
// `required_software` policy — the two non-patch policy types, both written
// to the SAME `/policies` resource as the `policies` (patch) config type, via
// ../lib/automoxPolicies. `findPolicyByName(..., expectedType)` keeps this
// config type from ever adopting a same-named PATCH policy.
//
// VERIFIED against the official OpenAPI description published in the Automox
// Console Python SDK (swagger-codegen, MIT license):
//   https://github.com/AutomoxCommunity/automox-console-sdk-python/blob/main/specs/ax_console.yaml
//   (schemas: CustomPolicyConfiguration — required: auto_reboot; optional:
//   notify_reboot_user, device_filters/device_filters_enabled,
//   missed_patch_window, os_family (enum Windows/Mac/Linux), evaluation_code,
//   remediation_code. RequiredSoftwarePolicyConfiguration — required:
//   package_name, package_version, installation_code; optional: os_family
//   (plain string, NOT enum-constrained for this type), device_filters/
//   device_filters_enabled, missed_patch_window.)
// FLAGGED: `evaluation_code`/`remediation_code` on a Required Software policy
// are NOT in RequiredSoftwarePolicyConfiguration's documented "properties"
// list, but Automox's own official `POST /policies` example body for
// required_software includes them (as null) — sent here only when the
// operator supplies a value. Verify against a live tenant.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { extractPolicyCommonFields, buildPolicyEnvelope, parseDeviceFilters, type PolicyCommonFields } from '../lib/automoxPolicies'
import { readBool, str } from '../lib/canvasValues'

export const WORKLET_TYPES = ['custom', 'required_software'] as const
export type WorkletType = (typeof WORKLET_TYPES)[number]

/** Enum-constrained for `custom` per CustomPolicyConfiguration.os_family; reused as a fixed choice for required_software too (see module doc — not a fabricated constraint, just a UX narrowing to the 3 real OS families). */
export const OS_FAMILIES = ['Windows', 'Mac', 'Linux'] as const

/** The desired state for one Worklet / Required Software policy, extracted from a canvas item. */
export interface WorkletSpec extends PolicyCommonFields {
  workletType: WorkletType
  osFamily: string
  missedPatchWindow: boolean
  deviceFiltersRaw: string
  // Custom (Worklet) fields.
  autoReboot: boolean
  notifyRebootUser: boolean
  evaluationCode: string
  remediationCode: string
  // Required Software fields.
  packageName: string
  packageVersion: string
  installationCode: string
  /** FLAGGED — see module doc. */
  requiredSoftwareEvaluationCode: string
  /** FLAGGED — see module doc. */
  requiredSoftwareRemediationCode: string
}

/** Each canvas item describes one Automox Worklet or Required Software policy. */
export function extractWorkletSpecs(canvas: CanvasSnapshot): WorkletSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      ...extractPolicyCommonFields(item),
      workletType: (str(fields.worklet_type) || 'custom') as WorkletType,
      osFamily: str(fields.os_family) || 'Windows',
      missedPatchWindow: readBool(fields.missed_patch_window, false),
      deviceFiltersRaw: str(fields.device_filters_json),
      autoReboot: readBool(fields.auto_reboot, true),
      notifyRebootUser: readBool(fields.notify_reboot_user, true),
      evaluationCode: str(fields.evaluation_code),
      remediationCode: str(fields.remediation_code),
      packageName: str(fields.package_name),
      packageVersion: str(fields.package_version),
      installationCode: str(fields.installation_code),
      requiredSoftwareEvaluationCode: str(fields.required_software_evaluation_code),
      requiredSoftwareRemediationCode: str(fields.required_software_remediation_code),
    }
  })
}

export interface BuiltConfiguration {
  configuration: Record<string, unknown>
  error?: string
}

/** Build `configuration` for a Custom (Worklet) policy (`CustomPolicyConfiguration`). */
export function buildCustomConfiguration(spec: WorkletSpec): BuiltConfiguration {
  const configuration: Record<string, unknown> = {
    auto_reboot: spec.autoReboot,
    notify_reboot_user: spec.notifyRebootUser,
    missed_patch_window: spec.missedPatchWindow,
    os_family: spec.osFamily,
  }
  if (!spec.evaluationCode) {
    return { configuration, error: 'Evaluation Code is required for a Custom (Worklet) policy.' }
  }
  configuration.evaluation_code = spec.evaluationCode
  if (spec.remediationCode) configuration.remediation_code = spec.remediationCode

  const deviceFilters = parseDeviceFilters(spec.deviceFiltersRaw)
  if (deviceFilters.error) return { configuration, error: deviceFilters.error }
  configuration.device_filters = deviceFilters.filters
  configuration.device_filters_enabled = deviceFilters.filters.length > 0

  return { configuration }
}

/** Build `configuration` for a Required Software policy (`RequiredSoftwarePolicyConfiguration`). */
export function buildRequiredSoftwareConfiguration(spec: WorkletSpec): BuiltConfiguration {
  const configuration: Record<string, unknown> = {
    os_family: spec.osFamily,
    missed_patch_window: spec.missedPatchWindow,
  }

  const missing: string[] = []
  if (!spec.packageName) missing.push('Package Name')
  if (!spec.packageVersion) missing.push('Package Version')
  if (!spec.installationCode) missing.push('Installation Code')
  if (missing.length > 0) {
    return { configuration, error: `Required Software policy is missing: ${missing.join(', ')}.` }
  }
  configuration.package_name = spec.packageName
  configuration.package_version = spec.packageVersion
  configuration.installation_code = spec.installationCode

  // FLAGGED (see module doc): not in the documented schema properties, but
  // present in Automox's own official example payload for this policy type.
  if (spec.requiredSoftwareEvaluationCode) configuration.evaluation_code = spec.requiredSoftwareEvaluationCode
  if (spec.requiredSoftwareRemediationCode) configuration.remediation_code = spec.requiredSoftwareRemediationCode

  const deviceFilters = parseDeviceFilters(spec.deviceFiltersRaw)
  if (deviceFilters.error) return { configuration, error: deviceFilters.error }
  configuration.device_filters = deviceFilters.filters
  configuration.device_filters_enabled = deviceFilters.filters.length > 0

  return { configuration }
}

/** Build `configuration` for the item's worklet type. */
export function buildConfiguration(spec: WorkletSpec): BuiltConfiguration {
  return spec.workletType === 'custom' ? buildCustomConfiguration(spec) : buildRequiredSoftwareConfiguration(spec)
}

export interface BuiltPolicyBody {
  body: Record<string, unknown>
  error?: string
}

/** Build the full Automox policy body (policy_type_name: custom | required_software) for POST/PUT /policies. */
export function buildWorkletBody(spec: WorkletSpec, organizationId: number): BuiltPolicyBody {
  const built = buildConfiguration(spec)
  if (built.error) return { body: {}, error: built.error }
  return { body: buildPolicyEnvelope(spec, spec.workletType, organizationId, built.configuration) }
}
