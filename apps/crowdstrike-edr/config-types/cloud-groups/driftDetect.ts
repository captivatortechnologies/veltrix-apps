import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins, type ModifiedResource } from '../lib/crowdstrikeAudit'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { CLOUD_GROUP_ENDPOINTS, type LiveCloudGroup } from './deploy'
import {
  extractCloudGroupSpecs,
  parseScoping,
  type CloudGroupSelectors,
  type CloudGroupSpec,
} from './validate'

/**
 * Detect drift between the deployed cloud group configuration and the live
 * tenant state. Looks up each declared group by name and diffs the managed
 * fields. Scope (selectors) is only compared when the group declared scoping —
 * a metadata-only group leaves the tenant scope unmanaged and never drifts on it.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractCloudGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const label = spec.name
    const before = diffs.length
    try {
      const live = (await findEntityByIdentity(
        client,
        CLOUD_GROUP_ENDPOINTS,
        spec.name,
      )) as LiveCloudGroup | null

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffCloudGroup(spec, live))

      // Attribute every diff this group produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), cloudGroupActorResource(live), { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Bridge a cloud group's `updated_by`/`updated_at` onto the audit reader shape. */
function cloudGroupActorResource(live: LiveCloudGroup): ModifiedResource {
  return { modified_by: live.updated_by, modified_on: live.updated_at }
}

function diffCloudGroup(spec: CloudGroupSpec, live: LiveCloudGroup): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  if (live.business_impact !== spec.businessImpact) {
    diffs.push({
      field: `${label}.businessImpact`,
      expected: spec.businessImpact,
      actual: live.business_impact ?? 'not set',
      severity: 'warning',
    })
  }

  if (live.environment !== spec.environment) {
    diffs.push({
      field: `${label}.environment`,
      expected: spec.environment,
      actual: live.environment ?? 'not set',
      severity: 'warning',
    })
  }

  if (spec.businessUnit !== undefined && (live.business_unit ?? '') !== spec.businessUnit) {
    diffs.push({
      field: `${label}.businessUnit`,
      expected: spec.businessUnit,
      actual: live.business_unit ?? 'not set',
      severity: 'warning',
    })
  }

  if (spec.description !== undefined && (live.description ?? '') !== spec.description) {
    diffs.push({
      field: `${label}.description`,
      expected: spec.description,
      actual: live.description ?? 'not set',
      severity: 'warning',
    })
  }

  if (!sameSet(Array.isArray(live.owners) ? live.owners : [], spec.owners)) {
    diffs.push({
      field: `${label}.owners`,
      expected: spec.owners.join(', ') || 'none',
      actual: (Array.isArray(live.owners) ? live.owners : []).join(', ') || 'none',
      severity: 'warning',
    })
  }

  // Scope is only managed when the group declared it.
  if (spec.scopingRaw) {
    const expected = canonicalizeSelectors(parseScoping(spec.scopingRaw).selectors)
    const actual = canonicalizeSelectors(live.selectors)
    if (expected !== actual) {
      diffs.push({
        field: `${label}.scoping`,
        expected: expected || 'none',
        actual: actual || 'none',
        severity: 'warning',
      })
    }
  }

  return diffs
}

/**
 * Stable string form of the managed selectors (cloud_resources + images) so
 * drift comparison ignores array/key ordering and unmanaged convenience fields.
 */
function canonicalizeSelectors(selectors: CloudGroupSelectors | undefined): string {
  if (!selectors) return ''
  const sortStrings = (list: unknown): string[] =>
    Array.isArray(list) ? list.map((v) => String(v)).sort() : []

  const cloud = (selectors.cloud_resources ?? [])
    .map((c) => ({
      cloud_provider: c.cloud_provider,
      account_ids: sortStrings(c.account_ids),
      region: sortStrings(c.filters?.region),
      tags: sortStrings(c.filters?.tags),
    }))
    .sort((a, b) => a.cloud_provider.localeCompare(b.cloud_provider))

  const images = (selectors.images ?? [])
    .map((i) => ({
      registry: i.registry,
      repository: sortStrings(i.filters?.repository),
      tag: sortStrings(i.filters?.tag),
    }))
    .sort((a, b) => a.registry.localeCompare(b.registry))

  if (cloud.length === 0 && images.length === 0) return ''
  return JSON.stringify({ cloud, images })
}
