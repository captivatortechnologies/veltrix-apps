// =============================================================================
// Shared logic for the two runtime-policy config types (container, host) —
// they share ONE wire shape and ONE endpoint (/api/v2/runtime_policies),
// differing only in the `type` body field. See lib/aquasec.ts's module doc
// for the endpoint citation.
// =============================================================================

import type { CanvasSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import type { AquaRuntimePolicy, RuntimeType } from '../../lib/aquasec'
import { buildScope, displayList, displayScope, normalizeBoolean, sameScope, splitList } from './common'

export interface RuntimePolicySpec {
  itemId?: string
  name: string
  description: string
  applicationScopes: string[]
  enabled: boolean
  enforce: boolean
  driftPreventionEnabled: boolean
  execLockdown: boolean
  imageLockdown: boolean
  allowedExecutablesEnabled: boolean
  allowedExecutables: string[]
  allowedRegistriesEnabled: boolean
  allowedRegistries: string[]
  blacklistedOsUsersEnabled: boolean
  userBlackList: string[]
  whitelistedOsUsersEnabled: boolean
  userWhiteList: string[]
  malwareScanEnabled: boolean
  malwareScanAction: string
  fileIntegrityMonitoringEnabled: boolean
  containerExecEnabled: boolean
  blockContainerExec: boolean
  reverseShellEnabled: boolean
  blockReverseShell: boolean
  portBlockEnabled: boolean
  blockInboundPorts: string[]
  blockOutboundPorts: string[]
  auditAllProcesses: boolean
  auditAllNetwork: boolean
  auditOnFailure: boolean
  scopeExpression: string
  scopeVariables: unknown
}

export function extractRuntimePolicySpecs(canvas: CanvasSnapshot): RuntimePolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(f.name ?? '').trim(),
      description: String(f.description ?? '').trim(),
      applicationScopes: splitList(f.applicationScopes),
      enabled: normalizeBoolean(f.enabled, true),
      enforce: normalizeBoolean(f.enforce, false),
      driftPreventionEnabled: normalizeBoolean(f.driftPreventionEnabled, false),
      execLockdown: normalizeBoolean(f.execLockdown, false),
      imageLockdown: normalizeBoolean(f.imageLockdown, false),
      allowedExecutablesEnabled: normalizeBoolean(f.allowedExecutablesEnabled, false),
      allowedExecutables: splitList(f.allowedExecutables),
      allowedRegistriesEnabled: normalizeBoolean(f.allowedRegistriesEnabled, false),
      allowedRegistries: splitList(f.allowedRegistries),
      blacklistedOsUsersEnabled: normalizeBoolean(f.blacklistedOsUsersEnabled, false),
      userBlackList: splitList(f.userBlackList),
      whitelistedOsUsersEnabled: normalizeBoolean(f.whitelistedOsUsersEnabled, false),
      userWhiteList: splitList(f.userWhiteList),
      malwareScanEnabled: normalizeBoolean(f.malwareScanEnabled, false),
      malwareScanAction: String(f.malwareScanAction ?? 'alert').trim(),
      fileIntegrityMonitoringEnabled: normalizeBoolean(f.fileIntegrityMonitoringEnabled, false),
      containerExecEnabled: normalizeBoolean(f.containerExecEnabled, false),
      blockContainerExec: normalizeBoolean(f.blockContainerExec, false),
      reverseShellEnabled: normalizeBoolean(f.reverseShellEnabled, false),
      blockReverseShell: normalizeBoolean(f.blockReverseShell, false),
      portBlockEnabled: normalizeBoolean(f.portBlockEnabled, false),
      blockInboundPorts: splitList(f.blockInboundPorts),
      blockOutboundPorts: splitList(f.blockOutboundPorts),
      auditAllProcesses: normalizeBoolean(f.auditAllProcesses, false),
      auditAllNetwork: normalizeBoolean(f.auditAllNetwork, false),
      auditOnFailure: normalizeBoolean(f.auditOnFailure, true),
      scopeExpression: String(f.scopeExpression ?? '').trim(),
      scopeVariables: f.scopeVariables,
    }
  })
}

export function buildRuntimePolicyBody(spec: RuntimePolicySpec, type: RuntimeType): AquaRuntimePolicy {
  return {
    name: spec.name,
    type,
    description: spec.description,
    application_scopes: spec.applicationScopes.length ? spec.applicationScopes : ['Global'],
    enabled: spec.enabled,
    enforce: spec.enforce,
    drift_prevention: {
      enabled: spec.driftPreventionEnabled,
      exec_lockdown: spec.execLockdown,
      image_lockdown: spec.imageLockdown,
    },
    allowed_executables: { enabled: spec.allowedExecutablesEnabled, allow_executables: spec.allowedExecutables },
    allowed_registries: { enabled: spec.allowedRegistriesEnabled, allowed_registries: spec.allowedRegistries },
    blacklisted_os_users: { enabled: spec.blacklistedOsUsersEnabled, user_black_list: spec.userBlackList, group_black_list: [] },
    whitelisted_os_users: { enabled: spec.whitelistedOsUsersEnabled, user_white_list: spec.userWhiteList, group_white_list: [] },
    malware_scan_options: { enabled: spec.malwareScanEnabled, action: spec.malwareScanAction },
    file_integrity_monitoring: { enabled: spec.fileIntegrityMonitoringEnabled },
    container_exec: { enabled: spec.containerExecEnabled, block_container_exec: spec.blockContainerExec },
    reverse_shell: { enabled: spec.reverseShellEnabled, block_reverse_shell: spec.blockReverseShell },
    port_block: {
      enabled: spec.portBlockEnabled,
      block_inbound_ports: spec.blockInboundPorts,
      block_outbound_ports: spec.blockOutboundPorts,
    },
    auditing: { enabled: spec.auditAllProcesses || spec.auditAllNetwork, audit_all_processes: spec.auditAllProcesses, audit_all_network: spec.auditAllNetwork },
    audit_on_failure: spec.auditOnFailure,
    scope: buildScope(spec.scopeExpression, spec.scopeVariables),
  }
}

export function diffRuntimePolicy(spec: RuntimePolicySpec, live: AquaRuntimePolicy): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const push = (field: string, expected: unknown, actual: unknown, severity: DriftDiff['severity'] = 'warning') => {
    diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity })
  }

  if (spec.enabled !== (live.enabled ?? true)) push('enabled', spec.enabled, live.enabled ?? true, 'critical')
  if (spec.enforce !== Boolean(live.enforce)) push('enforce', spec.enforce, Boolean(live.enforce), 'critical')

  const declaredScopes = displayList(spec.applicationScopes.length ? spec.applicationScopes : ['Global'])
  const actualScopes = displayList(live.application_scopes)
  if (declaredScopes !== actualScopes) push('applicationScopes', declaredScopes, actualScopes, 'critical')

  if (spec.driftPreventionEnabled !== Boolean(live.drift_prevention?.enabled)) {
    push('driftPreventionEnabled', spec.driftPreventionEnabled, Boolean(live.drift_prevention?.enabled))
  }
  if (spec.allowedExecutablesEnabled !== Boolean(live.allowed_executables?.enabled)) {
    push('allowedExecutablesEnabled', spec.allowedExecutablesEnabled, Boolean(live.allowed_executables?.enabled))
  } else if (spec.allowedExecutablesEnabled) {
    const declared = displayList(spec.allowedExecutables)
    const actual = displayList(live.allowed_executables?.allow_executables)
    if (declared !== actual) push('allowedExecutables', declared, actual)
  }
  if (spec.allowedRegistriesEnabled !== Boolean(live.allowed_registries?.enabled)) {
    push('allowedRegistriesEnabled', spec.allowedRegistriesEnabled, Boolean(live.allowed_registries?.enabled))
  } else if (spec.allowedRegistriesEnabled) {
    const declared = displayList(spec.allowedRegistries)
    const actual = displayList(live.allowed_registries?.allowed_registries)
    if (declared !== actual) push('allowedRegistries', declared, actual)
  }
  if (spec.malwareScanEnabled !== Boolean(live.malware_scan_options?.enabled)) {
    push('malwareScanEnabled', spec.malwareScanEnabled, Boolean(live.malware_scan_options?.enabled))
  }
  if (spec.fileIntegrityMonitoringEnabled !== Boolean(live.file_integrity_monitoring?.enabled)) {
    push('fileIntegrityMonitoringEnabled', spec.fileIntegrityMonitoringEnabled, Boolean(live.file_integrity_monitoring?.enabled))
  }
  if (spec.containerExecEnabled !== Boolean(live.container_exec?.enabled)) {
    push('containerExecEnabled', spec.containerExecEnabled, Boolean(live.container_exec?.enabled))
  }
  if (spec.reverseShellEnabled !== Boolean(live.reverse_shell?.enabled)) {
    push('reverseShellEnabled', spec.reverseShellEnabled, Boolean(live.reverse_shell?.enabled))
  }
  if (spec.portBlockEnabled !== Boolean(live.port_block?.enabled)) {
    push('portBlockEnabled', spec.portBlockEnabled, Boolean(live.port_block?.enabled))
  }
  if (spec.auditAllProcesses !== Boolean(live.auditing?.audit_all_processes)) {
    push('auditAllProcesses', spec.auditAllProcesses, Boolean(live.auditing?.audit_all_processes))
  }
  if (spec.auditAllNetwork !== Boolean(live.auditing?.audit_all_network)) {
    push('auditAllNetwork', spec.auditAllNetwork, Boolean(live.auditing?.audit_all_network))
  }

  const declaredScope = buildScope(spec.scopeExpression, spec.scopeVariables)
  if (!sameScope(declaredScope, live.scope)) push('scope', displayScope(declaredScope), displayScope(live.scope))

  return diffs
}
