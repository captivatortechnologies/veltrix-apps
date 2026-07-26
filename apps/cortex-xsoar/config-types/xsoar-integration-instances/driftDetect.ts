import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { attachDriftActor, veltrixActorLogins } from '../lib/xsoarAudit'
import { listIntegrationInstances } from './deploy'
import {
  extractIntegrationInstanceSpecs,
  isInstanceEnabled,
  SECRET_PARAM_TYPES,
  type LiveIntegrationInstance,
  type LiveIntegrationParam,
} from './validate'

/**
 * Detect drift between the deployed integration-instance configuration and the
 * live server. A missing instance is critical drift; a changed enabled flag,
 * classifier/mapper id, or non-secret parameter value is informational drift.
 * Encrypted/secret parameters (type 4/9) are masked by the API, so they are
 * never compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractIntegrationInstanceSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listIntegrationInstances(client)
    const byName = new Map<string, LiveIntegrationInstance>(
      live.filter((i) => i.name).map((i) => [i.name as string, i]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live object; attribute the deletion by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const liveEnabled = isInstanceEnabled(found)
      if (liveEnabled !== spec.enabled) {
        diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(liveEnabled), severity: 'info' })
      }

      compareId(diffs, spec.name, 'mappingId', spec.mappingId, found.mappingId)
      compareId(diffs, spec.name, 'incomingMapperId', spec.incomingMapperId, found.incomingMapperId)
      compareId(diffs, spec.name, 'outgoingMapperId', spec.outgoingMapperId, found.outgoingMapperId)

      const liveParams = indexParams(found.data ?? [])
      for (const [key, expected] of Object.entries(spec.parameters)) {
        const param = liveParams.get(key)
        if (!param) continue
        if (typeof param.type === 'number' && SECRET_PARAM_TYPES.has(param.type)) continue
        const actual = coerce(param.value)
        if (actual !== expected) {
          diffs.push({ field: `${spec.name}.${key}`, expected, actual, severity: 'info' })
        }
      }

      // Attribute every diff this instance produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id,
        targetName: spec.name,
        resource: found,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'cortex-xsoar',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Report drift on an optional id field only when the spec declares one. */
function compareId(
  diffs: DriftDiff[],
  name: string,
  field: string,
  expected: string | undefined,
  live: string | undefined,
): void {
  if (expected === undefined) return
  const actual = typeof live === 'string' ? live : ''
  if (expected !== actual) {
    diffs.push({ field: `${name}.${field}`, expected, actual: actual || 'not set', severity: 'info' })
  }
}

/** Index live params by both `name` and `display` for lookup by declared key. */
function indexParams(params: LiveIntegrationParam[]): Map<string, LiveIntegrationParam> {
  const map = new Map<string, LiveIntegrationParam>()
  for (const param of params) {
    if (param.name) map.set(param.name, param)
    if (param.display && !map.has(param.display)) map.set(param.display, param)
  }
  return map
}

/** Coerce a live param value to a comparable string. */
function coerce(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}
