import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { IT_POLICY_ENDPOINTS } from './deploy'
import {
  extractITPolicySpecs,
  flattenConfig,
  parsePolicyConfig,
  readLiveEnabled,
  readLiveHostGroups,
  type ITPolicySpec,
  type LiveITPolicy,
} from './validate'

/**
 * Detect drift between the deployed IT automation policy configuration and the
 * live tenant state. Looks up each declared policy by name and diffs enablement,
 * the declared config keys, description, and host groups. Config comparison is
 * scoped to the keys the canvas declares; host groups are only compared when the
 * live resource actually exposes them, so unmanaged/unverified fields never
 * manufacture false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractITPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = (await findEntityByIdentity(
        client,
        IT_POLICY_ENDPOINTS,
        spec.name,
      )) as LiveITPolicy | null

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffPolicy(spec, live))

      attachDriftActor(diffs.slice(before), policyActorResource(live), { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Bridge a policy's modifier fields onto the audit reader shape. */
function policyActorResource(live: LiveITPolicy): ModifiedResource {
  return {
    modified_by: live.modified_by ?? live.updated_by,
    modified_timestamp: live.modified_timestamp ?? live.updated_timestamp,
    modified_on: live.modified_on,
  }
}

function diffPolicy(spec: ITPolicySpec, live: LiveITPolicy): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  // Enablement decides whether the policy is active
  const liveEnabled = readLiveEnabled(live)
  if (liveEnabled !== undefined && liveEnabled !== spec.enabled) {
    diffs.push({
      field: `${label}.enabled`,
      expected: spec.enabled,
      actual: liveEnabled,
      severity: 'warning',
    })
  }

  // Declared config keys vs live values (scoped to what the canvas declares)
  const declared = flattenConfig(parsePolicyConfig(spec.configRaw).config)
  const liveConfig = flattenConfig(
    live.config && typeof live.config === 'object' ? (live.config as Record<string, unknown>) : undefined,
  )
  for (const [path, expected] of declared) {
    const actual = liveConfig.get(path)
    if (actual !== expected) {
      diffs.push({
        field: `${label}.config.${path}`,
        expected,
        actual: actual ?? 'not present on policy',
        severity: 'warning',
      })
    }
  }

  // Description
  const liveDescription = (live.description ?? '').trim()
  if ((spec.description ?? '') !== liveDescription) {
    diffs.push({
      field: `${label}.description`,
      expected: spec.description ?? 'not set',
      actual: liveDescription || 'not set',
      severity: 'info',
    })
  }

  // Host groups — only when the live resource exposes them.
  const liveGroups = readLiveHostGroups(live)
  if (liveGroups !== undefined && !sameSet(liveGroups, spec.hostGroups)) {
    diffs.push({
      field: `${label}.hostGroups`,
      expected: spec.hostGroups.join(', ') || 'none',
      actual: liveGroups.join(', ') || 'none',
      severity: 'warning',
    })
  }

  return diffs
}
