// =============================================================================
// Shared pipeline orchestration for every Panorama config type.
//
// The deploy/rollback/healthCheck/driftDetect/getStatus flow is identical across
// object types — only the REST resource path, the field builder and the drift
// comparator differ. Each config type builds its `UpsertSpec[]` (name + REST
// entry fields) and its declared-name list, then calls these runners. This keeps
// every handler file thin while the write + commit + rollback logic lives once.
//
// Deploy model: write objects to the candidate config via REST, recording for
// each whether it already existed and — when it did — the live object as it was
// before the write; then commit to Panorama (XML) when auto_commit is on and
// poll the job. Rollback: DELETE what this deploy CREATED (tolerating 404) and
// PUT back the prior state of what it OVERWROTE, then commit. It never deletes
// an object it did not create, and never attempts a candidate-revert (too
// fragile / too broad).
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
  entryFields,
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
    const commit = await commitIfEnabled(client, settings, deployed.length > 0)

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
 * Roll back by deleting the objects this deploy created and restoring the prior
 * state of the ones it overwrote, then committing when auto_commit is on.
 *
 * An object the customer already had is never DELETED — that would be an outage,
 * not a rollback — but leaving it alone is not an undo either: it keeps the
 * deployed values while the operator is told the rollback succeeded. Deploy
 * captures the live object before it writes, so it can be put back.
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
  const overwritten = rollback.filter((r) => r.existed && r.prior)
  // An update recorded before deploy captured prior state — nothing can be put
  // back. Named rather than counted as "left unchanged", which read as a
  // deliberate choice when it was a gap.
  const unrestorable = rollback.filter((r) => r.existed && !r.prior)
  const deleted: string[] = []
  const restored: string[] = []

  try {
    for (const entry of [...created].reverse()) {
      const res = await client.deleteObject(resourcePath, entry.name)
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete "${entry.name}": ${panoramaErrorMessage(res)}`)
      }
      deleted.push(entry.name)
    }

    // Put back what this deploy overwrote. Undoing only the creates left a
    // customer's existing rule carrying the deployed configuration while the
    // operator was told the rollback had succeeded.
    for (const entry of [...overwritten].reverse()) {
      const res = await client.updateObject(resourcePath, entry.name, entryFields(entry.prior as PanoramaEntry))
      if (!res.ok) {
        throw new Error(`Failed to restore "${entry.name}": ${panoramaErrorMessage(res)}`)
      }
      restored.push(entry.name)
    }

    const commit = await commitIfEnabled(client, settings, deleted.length + restored.length > 0)

    const note = unrestorable.length
      ? ` Not restored (no prior state was recorded for them): ${unrestorable.map((r) => r.name).join(', ')}.`
      : ''
    return {
      success: unrestorable.length === 0,
      message:
        `Rolled back ${deleted.length} created and ${restored.length} overwritten ` +
        `${typeLabel}.${note} ${commit.message}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after deleting ${deleted.length} of ${created.length} created and restoring ${restored.length} of ${overwritten.length} overwritten ${typeLabel}: ${
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
  // `PanoramaClient.send` does not catch transport errors, so a DNS failure, a
  // refused connection or the request timeout used to propagate out of the
  // handler. An unreachable Panorama then surfaced as an opaque pipeline crash
  // rather than "unhealthy, cannot reach panorama.example.com" — which is the
  // one case a health check exists for.
  let listed: Awaited<ReturnType<typeof client.list>>
  try {
    listed = await client.list(resourcePath)
  } catch (error) {
    checks.push({
      name: 'panorama_reachable',
      passed: false,
      message: `Panorama unreachable at ${panoramaUrl} (${where}): ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
      latencyMs: Date.now() - start,
    })
    return { healthy: false, score: 0, checks }
  }
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
    // No usable credential means nothing was read. A bare `hasDrift: false` is a
    // positive assurance the platform acts on — it resolves the component's
    // outstanding drift record — so a rotated or revoked key would silently
    // clear real drift on every scheduled run.
    return { hasDrift: false, diffs: [], checked: false }
  }
  const { client } = built

  // `PanoramaClient.send` does not catch transport errors, so a DNS failure, a
  // refused connection or the request timeout used to propagate out of the
  // handler as an opaque pipeline crash. Deploy and rollback already wrap their
  // work; drift did not.
  let listed: Awaited<ReturnType<typeof client.list>>
  try {
    listed = await client.list(resourcePath)
  } catch (error) {
    // Reported the same way as a refused list below — visibly, not silently —
    // rather than propagating. Deploy and rollback already wrap their work.
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'panorama',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown error'}`,
          severity: 'critical',
        },
      ],
    }
  }
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
