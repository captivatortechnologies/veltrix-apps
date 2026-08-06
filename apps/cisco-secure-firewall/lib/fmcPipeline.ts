// =============================================================================
// Shared pipeline orchestration for every flat, name-keyed FMC object type
// (Access Control Policies, Network/Port/URL Objects & Groups, Security
// Zones). Access Rules has its own runner (it nests under a parent policy and
// needs richer per-rule resolution) but reuses the same upsert/rollback
// primitives from lib/fmc.ts.
//
// Deploy model: upsert each object by name (list -> match -> PUT or POST),
// tracking what was CREATED for rollback, then optionally trigger a
// deploy-to-devices activation (see lib/fmc.ts's `deployToDevicesIfEnabled`).
// Rollback deletes only what deploy created (tolerating 404) - it never
// restores objects that were updated in place, and never touches anything it
// did not create - the same non-destructive model
// apps/palo-alto-panorama/lib/pipeline.ts uses.
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
  buildFmcClient,
  deployToDevicesIfEnabled,
  fmcErrorMessage,
  upsertByName,
  type DeployedObject,
  type FmcObject,
  type UpsertSpec,
} from './fmc'

export const COMPONENT_TYPE = 'fmc'

interface FmcRollbackData {
  rollback?: DeployedObject[]
  path?: string
}

/** Deploy a set of name-keyed objects, then optionally trigger deploy-to-devices, recording rollback state. */
export async function runDeploy(
  ctx: DeployContext,
  path: string,
  specs: UpsertSpec[],
  typeLabel: string,
): Promise<DeployResult> {
  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, fmcUrl, settings } = built

  const rollback: DeployedObject[] = []
  const deployed: string[] = []

  try {
    await upsertByName(client, path, specs, rollback, deployed)
    const activation = await deployToDevicesIfEnabled(client, settings)

    return {
      success: true,
      message: `Deployed ${deployed.length} ${typeLabel} to ${fmcUrl}. ${activation.message}`,
      artifacts: { fmcUrl, deployed, deployedToDevices: activation.triggered, deviceCount: activation.deviceCount },
      rollbackData: { rollback, path },
    }
  } catch (error) {
    return {
      success: false,
      message: `${typeLabel} deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { fmcUrl, deployed },
      rollbackData: { rollback, path },
    }
  }
}

/** Roll back by deleting (by id) only the objects this deploy created, then optionally triggering deploy-to-devices. */
export async function runRollback(ctx: RollbackContext, typeLabel: string): Promise<RollbackResult> {
  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, settings } = built

  const data = (ctx.rollbackData as FmcRollbackData) ?? {}
  const rollback = data.rollback ?? []
  const path = data.path
  if (!path) {
    return { success: false, message: 'No rollback state available (missing resource path) - nothing to undo.' }
  }

  const created = rollback.filter((r) => !r.existed)
  const preExisting = rollback.filter((r) => r.existed)
  const deleted: string[] = []

  try {
    for (const entry of [...created].reverse()) {
      const res = await client.deleteObject(path, entry.id)
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete "${entry.name}": ${fmcErrorMessage(res)}`)
      }
      deleted.push(entry.name)
    }
    const activation = await deployToDevicesIfEnabled(client, settings)

    const kept = preExisting.length ? ` Left ${preExisting.length} pre-existing ${typeLabel} unchanged.` : ''
    return {
      success: true,
      message: `Rolled back ${deleted.length} created ${typeLabel}.${kept} ${activation.message}`,
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

/** Health check: FMC reachability + credential validity (a list call), then that every declared object exists. */
export async function runHealthCheck(
  ctx: HealthCheckContext,
  path: string,
  declaredNames: string[],
  typeLabel: string,
): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'fmc_credential', passed: false, message: built.error }] }
  }
  const { client, fmcUrl } = built

  const start = Date.now()
  const listed = await client.list(path)
  if (!listed.ok) {
    checks.push({
      name: 'fmc_reachable',
      passed: false,
      message: `FMC list failed: HTTP ${listed.status}`,
      latencyMs: Date.now() - start,
    })
    return { healthy: false, score: 0, checks }
  }
  checks.push({ name: 'fmc_reachable', passed: true, message: `FMC reachable at ${fmcUrl}`, latencyMs: Date.now() - start })

  const liveNames = new Set(listed.items.map((i) => (i.name ?? '').toLowerCase()).filter(Boolean))
  for (const name of declaredNames) {
    const present = liveNames.has(name.toLowerCase())
    checks.push({ name: `${typeLabel}:${name}`, passed: present, message: present ? `"${name}" is present` : `"${name}" is missing` })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}

/** Drift detection: re-find each declared object by name and diff it via the caller's comparator. */
export async function runDriftDetect<T extends { name: string }>(
  ctx: DriftContext,
  path: string,
  specs: T[],
  compare: (spec: T, live: FmcObject) => DriftDiff[],
): Promise<DriftResult> {
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const listed = await client.list(path)
  if (!listed.ok) {
    return {
      hasDrift: true,
      diffs: [{ field: 'fmc', expected: 'reachable', actual: `list failed (HTTP ${listed.status})`, severity: 'critical' }],
    }
  }

  const byName = new Map(listed.items.map((item) => [(item.name ?? '').toLowerCase(), item]))
  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const live = byName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    diffs.push(...compare(spec, live))
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Report deployment status against FMC components. Shared by every config type. */
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
