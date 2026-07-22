// =============================================================================
// Shared pipeline orchestration for every Panorama config type.
//
// The deploy/rollback/healthCheck/driftDetect/getStatus flow is identical across
// object types — only the REST resource path, the field builder and the drift
// comparator differ. Each config type builds its `UpsertSpec[]` (name + REST
// entry fields) and its declared-name list, then calls these runners. This keeps
// every handler file thin while the write + commit + rollback logic lives once.
//
// Deploy model: write objects to the candidate config via REST, tracking each
// created object for rollback; then commit to Panorama (XML) when auto_commit is
// on and poll the job. Rollback: DELETE only the objects this deploy CREATED
// (tolerating 404), then commit — never touches objects it did not create, and
// never attempts a candidate-revert (too fragile / too broad).
// =============================================================================

import type {
  ComponentConfigStatus,
  ConfigStatus,
  DeployContext,
  DeployResult,
  DriftContext,
  DriftDiff,
  DriftResult,
  HealthCheckContext,
  HealthCheckResult,
  PipelineContext,
  RollbackContext,
  RollbackResult,
} from '@veltrixsecops/app-sdk'
import {
  buildPanoramaClient,
  commitIfEnabled,
  locationLabel,
  panoramaErrorMessage,
  upsertObjects,
  type DeployedObject,
  type PanoramaEntry,
  type PanoramaSettings,
  type UpsertSpec,
} from './panorama'
import { attachDriftActor, veltrixActorLogins } from './panoramaAudit'

export const COMPONENT_TYPE = 'panorama'

interface PanoramaRollbackData {
  rollback?: DeployedObject[]
  resourcePath?: string
}

/** Deploy a set of objects, commit if enabled, and record rollback state. */
export async function runDeploy(
  ctx: DeployContext,
  resourcePath: string,
  specs: UpsertSpec[],
  typeLabel: string,
): Promise<DeployResult> {
  const built = buildPanoramaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, panoramaUrl, location, settings } = built
  const where = locationLabel(location)

  const rollback: DeployedObject[] = []
  const deployed: string[] = []

  try {
    await upsertObjects(client, resourcePath, specs, rollback, deployed)
    const commit = await commitIfEnabled(client, settings)

    return {
      success: true,
      message: `Deployed ${deployed.length} ${typeLabel} to ${panoramaUrl} (${where}). ${commit.message}`,
      artifacts: {
        panoramaUrl,
        location: where,
        deployed,
        committed: commit.committed,
        commitJobId: commit.jobId,
      },
      rollbackData: { rollback, resourcePath },
    }
  } catch (error) {
    return {
      success: false,
      message: `${typeLabel} deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { panoramaUrl, location: where, deployed },
      rollbackData: { rollback, resourcePath },
    }
  }
}

/**
 * Roll back by deleting only the objects this deploy created, then committing
 * when auto_commit is on. Objects that pre-existed (updated in place) are left
 * as-is — rollback is deliberately non-destructive to anything it did not create.
 */
export async function runRollback(ctx: RollbackContext, typeLabel: string): Promise<RollbackResult> {
  const built = buildPanoramaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, settings } = built

  const data = (ctx.rollbackData as PanoramaRollbackData) ?? {}
  const rollback = data.rollback ?? []
  const resourcePath = data.resourcePath
  if (!resourcePath) {
    return { success: false, message: 'No rollback state available (missing resource path) — nothing to undo.' }
  }

  const created = rollback.filter((r) => !r.existed)
  const preExisting = rollback.filter((r) => r.existed)
  const deleted: string[] = []

  try {
    for (const entry of [...created].reverse()) {
      const res = await client.deleteObject(resourcePath, entry.name)
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete "${entry.name}": ${panoramaErrorMessage(res)}`)
      }
      deleted.push(entry.name)
    }
    const commit = await commitIfEnabled(client, settings)

    const kept = preExisting.length
      ? ` Left ${preExisting.length} pre-existing ${typeLabel} unchanged.`
      : ''
    return {
      success: true,
      message: `Rolled back ${deleted.length} created ${typeLabel}.${kept} ${commit.message}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after deleting ${deleted.length} of ${created.length} created ${typeLabel}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/**
 * Health check: Panorama reachability + credential validity (a REST list), then
 * that every declared object is present. Score = percentage of passed checks.
 */
export async function runHealthCheck(
  ctx: HealthCheckContext,
  resourcePath: string,
  declaredNames: string[],
  typeLabel: string,
): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPanoramaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'panorama_credential', passed: false, message: built.error }] }
  }
  const { client, panoramaUrl, location } = built
  const where = locationLabel(location)

  const start = Date.now()
  const listed = await client.list(resourcePath)
  if (!listed.ok) {
    checks.push({
      name: 'panorama_reachable',
      passed: false,
      message: `Panorama list failed (${where}): ${panoramaErrorMessage({ status: listed.status, ok: false, body: listed.body })}`,
      latencyMs: Date.now() - start,
    })
    return { healthy: false, score: 0, checks }
  }
  checks.push({
    name: 'panorama_reachable',
    passed: true,
    message: `Panorama reachable at ${panoramaUrl} (${where})`,
    latencyMs: Date.now() - start,
  })

  const liveNames = new Set(
    listed.entries.map((e) => (typeof e['@name'] === 'string' ? (e['@name'] as string).toLowerCase() : '')).filter(Boolean),
  )
  for (const name of declaredNames) {
    const present = liveNames.has(name.toLowerCase())
    checks.push({
      name: `${typeLabel}:${name}`,
      passed: present,
      message: present ? `"${name}" is present` : `"${name}" is missing`,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}

/**
 * Drift detection: re-find each declared object by name and diff its managed
 * fields via the caller's comparator. A missing object is critical drift.
 */
export async function runDriftDetect<T extends { name: string }>(
  ctx: DriftContext,
  resourcePath: string,
  specs: T[],
  compare: (spec: T, entry: PanoramaEntry) => DriftDiff[],
): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const built = buildPanoramaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const listed = await client.list(resourcePath)
  if (!listed.ok) {
    return {
      hasDrift: true,
      diffs: [{ field: 'panorama', expected: 'reachable', actual: `list failed (HTTP ${listed.status})`, severity: 'critical' }],
    }
  }

  const byName = new Map<string, PanoramaEntry>()
  for (const entry of listed.entries) {
    const name = typeof entry['@name'] === 'string' ? (entry['@name'] as string).toLowerCase() : ''
    if (name) byName.set(name, entry)
  }

  // Veltrix's own deploys are recorded in the config log under the connection
  // admin — exclude it so attribution reflects the MANUAL change, not our deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const found = byName.get(spec.name.toLowerCase())
    // Diffs for THIS object, so attribution resolves once per drifted object.
    const objectDiffs: DriftDiff[] = found
      ? compare(spec, found)
      : [{ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' }]

    if (objectDiffs.length > 0) {
      // Best-effort "who + when" — never throws, never fails a drift check.
      await attachDriftActor(client, objectDiffs, { objectName: spec.name, excludeActorLogins })
      diffs.push(...objectDiffs)
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Report deployment status against Panorama components. Shared by all types. */
export async function runGetStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latestDeployment = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latestDeployment) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: [COMPONENT_TYPE] })
  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || '',
    healthy: latestDeployment.healthScore != null ? latestDeployment.healthScore >= 80 : undefined,
    healthScore: latestDeployment.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || latestDeployment.startedAt,
    componentStatuses,
  }
}

/** Read a settings record into a resolved PanoramaSettings (used by tests). */
export type { PanoramaSettings }
