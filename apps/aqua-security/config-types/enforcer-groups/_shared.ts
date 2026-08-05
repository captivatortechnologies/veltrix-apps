// =============================================================================
// Shared spec/validation/wire-format helpers for the Aqua Security
// enforcer-groups config type (validate + deploy + rollback + drift).
// Mirrors client.EnforcerGroup / client.EnforcerOrchestrator /
// client.EnforcerScheduleScanSettings (client/enforcers.go) — see
// lib/aquasec.ts's module doc for the endpoint citation.
// =============================================================================

import type { CanvasSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import type { AquaEnforcerGroup } from '../../lib/aquasec'
import { normalizeBoolean, sameStringSet, splitList } from '../lib/common'

export interface EnforcerGroupSpec {
  itemId?: string
  groupId: string
  logicalName: string
  description: string
  type: string
  enforce: boolean
  orchestratorType: string
  orchestratorMaster: boolean
  orchestratorServiceAccount: string
  orchestratorNamespace: string
  containerActivityProtection: boolean
  networkProtection: boolean
  hostNetworkProtection: boolean
  hostProtection: boolean
  hostAssurance: boolean
  imageAssurance: boolean
  admissionControl: boolean
  autoDiscoveryEnabled: boolean
  allowedApplications: string[]
  allowedLabels: string[]
  allowedRegistries: string[]
  scheduleScanDisabled: boolean
  scheduleScanDays: number[]
  scheduleScanTime: number[]
}

function toIntList(value: unknown): number[] {
  return splitList(value)
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n))
}

export function extractEnforcerGroupSpecs(canvas: CanvasSnapshot): EnforcerGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      groupId: String(f.groupId ?? '').trim(),
      logicalName: String(f.logicalName ?? '').trim(),
      description: String(f.description ?? '').trim(),
      type: String(f.type ?? 'agent').trim(),
      enforce: normalizeBoolean(f.enforce, false),
      orchestratorType: String(f.orchestratorType ?? 'kubernetes').trim(),
      orchestratorMaster: normalizeBoolean(f.orchestratorMaster, false),
      orchestratorServiceAccount: String(f.orchestratorServiceAccount ?? '').trim(),
      orchestratorNamespace: String(f.orchestratorNamespace ?? '').trim(),
      containerActivityProtection: normalizeBoolean(f.containerActivityProtection, true),
      networkProtection: normalizeBoolean(f.networkProtection, true),
      hostNetworkProtection: normalizeBoolean(f.hostNetworkProtection, false),
      hostProtection: normalizeBoolean(f.hostProtection, false),
      hostAssurance: normalizeBoolean(f.hostAssurance, false),
      imageAssurance: normalizeBoolean(f.imageAssurance, true),
      admissionControl: normalizeBoolean(f.admissionControl, false),
      autoDiscoveryEnabled: normalizeBoolean(f.autoDiscoveryEnabled, false),
      allowedApplications: splitList(f.allowedApplications),
      allowedLabels: splitList(f.allowedLabels),
      allowedRegistries: splitList(f.allowedRegistries),
      scheduleScanDisabled: normalizeBoolean(f.scheduleScanDisabled, false),
      scheduleScanDays: toIntList(f.scheduleScanDays),
      scheduleScanTime: toIntList(f.scheduleScanTime),
    }
  })
}

export function buildEnforcerGroupBody(spec: EnforcerGroupSpec): AquaEnforcerGroup {
  return {
    id: spec.groupId,
    logicalname: spec.logicalName || spec.groupId,
    description: spec.description,
    type: spec.type,
    enforce: spec.enforce,
    orchestrator: {
      type: spec.orchestratorType,
      master: spec.orchestratorMaster,
      service_account: spec.orchestratorServiceAccount || undefined,
      namespace: spec.orchestratorNamespace || undefined,
    },
    container_activity_protection: spec.containerActivityProtection,
    network_protection: spec.networkProtection,
    host_network_protection: spec.hostNetworkProtection,
    host_protection: spec.hostProtection,
    host_assurance: spec.hostAssurance,
    image_assurance: spec.imageAssurance,
    admission_control: spec.admissionControl,
    auto_discovery_enabled: spec.autoDiscoveryEnabled,
    allowed_applications: spec.allowedApplications,
    allowed_labels: spec.allowedLabels,
    allowed_registries: spec.allowedRegistries,
    schedule_scan_settings: {
      disabled: spec.scheduleScanDisabled,
      days: spec.scheduleScanDays,
      time: spec.scheduleScanTime,
    },
  }
}

export function diffEnforcerGroup(spec: EnforcerGroupSpec, live: AquaEnforcerGroup): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const push = (field: string, expected: unknown, actual: unknown, severity: DriftDiff['severity'] = 'warning') => {
    diffs.push({ field: `${spec.groupId}.${field}`, expected, actual, severity })
  }

  if (spec.enforce !== Boolean(live.enforce)) push('enforce', spec.enforce, Boolean(live.enforce), 'critical')
  if (spec.imageAssurance !== Boolean(live.image_assurance)) push('imageAssurance', spec.imageAssurance, Boolean(live.image_assurance), 'critical')
  if (spec.containerActivityProtection !== Boolean(live.container_activity_protection)) {
    push('containerActivityProtection', spec.containerActivityProtection, Boolean(live.container_activity_protection))
  }
  if (spec.networkProtection !== Boolean(live.network_protection)) push('networkProtection', spec.networkProtection, Boolean(live.network_protection))
  if (spec.hostProtection !== Boolean(live.host_protection)) push('hostProtection', spec.hostProtection, Boolean(live.host_protection))
  if (spec.hostAssurance !== Boolean(live.host_assurance)) push('hostAssurance', spec.hostAssurance, Boolean(live.host_assurance))
  if (spec.admissionControl !== Boolean(live.admission_control)) push('admissionControl', spec.admissionControl, Boolean(live.admission_control), 'critical')
  if (spec.autoDiscoveryEnabled !== Boolean(live.auto_discovery_enabled)) push('autoDiscoveryEnabled', spec.autoDiscoveryEnabled, Boolean(live.auto_discovery_enabled))

  if (!sameStringSet(spec.allowedApplications, live.allowed_applications ?? [])) {
    push('allowedApplications', spec.allowedApplications.join(', '), (live.allowed_applications ?? []).join(', '))
  }
  if (!sameStringSet(spec.allowedRegistries, live.allowed_registries ?? [])) {
    push('allowedRegistries', spec.allowedRegistries.join(', '), (live.allowed_registries ?? []).join(', '))
  }

  return diffs
}
