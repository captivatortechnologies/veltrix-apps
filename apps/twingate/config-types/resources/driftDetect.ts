import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listGroups, listRemoteNetworks, listResources, readResource } from './deploy'
import {
  byName,
  declaredPortsSignature,
  extractResourceSpecs,
  idSetSignature,
  portsSignature,
  resourceKey,
  type FullResource,
  type NamedRef,
  type ResourceSpec,
} from './_shared'

/**
 * Detect drift between the deployed Resource configuration and the live
 * Twingate network. Re-finds each declared resource by name and diffs the
 * managed fields: a missing resource is critical drift; a changed address,
 * remote network, alias, visibility flag, protocol policy/ports or group
 * access is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractResourceSpecs(ctx.deployedConfig).filter((s) => s.name && s.address && s.remoteNetworkName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listResources(client)
    const resourcesByName = new Map(live.filter((r) => r.name).map((r) => [resourceKey(r.name as string), r]))

    const networksByName = byName(await listRemoteNetworks(client))
    const needsGroups = specs.some((s) => s.groupNames.length > 0)
    const groupsByName = needsGroups ? byName(await listGroups(client)) : new Map<string, NamedRef>()

    for (const spec of specs) {
      const label = spec.name
      const found = resourcesByName.get(resourceKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const full = await readResource(client, found.id)
      diffFields(spec, full, label, networksByName, groupsByName, diffs)
    }
  } catch (error) {
    diffs.push({
      field: 'twingate',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffFields(
  spec: ResourceSpec,
  full: FullResource,
  label: string,
  networksByName: Map<string, NamedRef>,
  groupsByName: Map<string, NamedRef>,
  diffs: DriftDiff[],
): void {
  const push = (suffix: string, expected: unknown, actual: unknown) =>
    diffs.push({ field: `${label}.${suffix}`, expected, actual, severity: 'warning' })

  if ((full.address?.value ?? '') !== spec.address) {
    push('address', spec.address, full.address?.value ?? 'not set')
  }
  if ((full.alias ?? '') !== spec.alias) {
    push('alias', spec.alias || '(none)', full.alias || '(none)')
  }

  const declaredNetwork = networksByName.get(resourceKey(spec.remoteNetworkName))
  if (!declaredNetwork?.id) {
    push('remote_network_name', spec.remoteNetworkName, 'not found in Twingate')
  } else if ((full.remoteNetwork?.id ?? '') !== declaredNetwork.id) {
    push('remote_network_name', spec.remoteNetworkName, full.remoteNetwork?.name ?? 'changed')
  }

  const liveVisible = full.isVisible ?? true
  if (liveVisible !== spec.isVisible) push('is_visible', String(spec.isVisible), String(liveVisible))

  const liveShortcut = full.isBrowserShortcutEnabled ?? false
  if (liveShortcut !== spec.isBrowserShortcutEnabled) {
    push('is_browser_shortcut_enabled', String(spec.isBrowserShortcutEnabled), String(liveShortcut))
  }

  const liveIcmp = full.protocols?.allowIcmp ?? true
  if (liveIcmp !== spec.allowIcmp) push('allow_icmp', String(spec.allowIcmp), String(liveIcmp))

  if ((full.protocols?.tcp?.policy ?? 'ALLOW_ALL') !== spec.tcpPolicy) {
    push('tcp_policy', spec.tcpPolicy, full.protocols?.tcp?.policy ?? 'not set')
  } else if (spec.tcpPolicy === 'RESTRICTED') {
    const liveSig = portsSignature(full.protocols?.tcp?.ports)
    const declaredSig = declaredPortsSignature(spec.tcpPorts)
    if (liveSig !== declaredSig) push('tcp_ports', declaredSig || '(none)', liveSig || '(none)')
  }

  if ((full.protocols?.udp?.policy ?? 'ALLOW_ALL') !== spec.udpPolicy) {
    push('udp_policy', spec.udpPolicy, full.protocols?.udp?.policy ?? 'not set')
  } else if (spec.udpPolicy === 'RESTRICTED') {
    const liveSig = portsSignature(full.protocols?.udp?.ports)
    const declaredSig = declaredPortsSignature(spec.udpPorts)
    if (liveSig !== declaredSig) push('udp_ports', declaredSig || '(none)', liveSig || '(none)')
  }

  const declaredGroupIds = spec.groupNames
    .map((name) => groupsByName.get(resourceKey(name))?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const missingGroups = spec.groupNames.filter((name) => !groupsByName.get(resourceKey(name))?.id)
  if (missingGroups.length > 0) {
    push('group_names', spec.groupNames.join(', '), `not found in Twingate: ${missingGroups.join(', ')}`)
  } else {
    const liveGroupIds = (full.groups?.edges ?? [])
      .map((e) => e?.node?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    const declaredSig = idSetSignature(declaredGroupIds)
    const liveSig = idSetSignature(liveGroupIds)
    if (declaredSig !== liveSig) {
      push('group_names', `${declaredGroupIds.length} group(s)`, `${liveGroupIds.length} group(s) in Twingate`)
    }
  }
}
