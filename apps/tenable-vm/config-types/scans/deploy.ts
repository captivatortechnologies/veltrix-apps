import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { assembleRrules, extractScanSpecs, type LiveScan, type ScanSpec } from './validate'

export interface ScanRollbackEntry {
  name: string
  existed: boolean
  /** Numeric id returned by the API — the rollback key. */
  id?: number
  /** Prior scan settings captured before an update, replayed (PUT) on rollback. */
  prior?: { settings?: Record<string, unknown> }
}

/**
 * Deploy scheduled scans to a Tenable VM tenant via the Scans API.
 *
 * For each declared scan:
 *   - GET  /scans                    — list + find by name
 *   - GET  /scans/{id}               — capture prior settings before an update
 *   - PUT  /scans/{id}               — update existing (keyed on the numeric id)
 *   - POST /scans                    — create missing (capture the created id)
 *
 * Names are not guaranteed unique by the API, so create-vs-update is decided by
 * the first name match in the live list and rollback is keyed on the id the API
 * returns — never on the name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractScanSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ScanRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findScan(client, spec.name)

      if (existing && existing.id !== undefined) {
        // Capture the prior settings so rollback can PUT the scan back. The list
        // summary omits targets/schedule, so read the detail for a faithful copy.
        const prior = await getScanSettings(client, existing.id)
        rollbackState.push({ name: spec.name, existed: true, id: existing.id, prior: { settings: prior } })

        const res = await client.request('PUT', `/scans/${existing.id}`, { body: buildScanBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update scan "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/scans', { body: buildScanBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create scan "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        // POST /scans wraps the created scan under `scan`; fall back to a bare object.
        const created =
          parseJson<{ scan?: LiveScan } & LiveScan>(res.body) ?? undefined
        const createdId = created?.scan?.id ?? created?.id
        rollbackState.push({ name: spec.name, existed: false, id: createdId })
        if (createdId === undefined) {
          throw new Error(`Scan "${spec.name}" was created but the API returned no id`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} scan(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedScans: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scan deployment failed after ${deployed.length} of ${specs.length} scan(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedScans: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  }
}

// --- Helpers ---

/** Look up a scan by exact name in the tenant list; null when absent. */
export async function findScan(client: TenableClient, name: string): Promise<LiveScan | null> {
  const res = await client.request('GET', '/scans')
  if (!res.ok) {
    throw new Error(`Failed to list scans while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const scans = parseJson<{ scans?: LiveScan[] }>(res.body)?.scans ?? []
  // Names are not guaranteed unique — match the first exact name. Rollback is
  // keyed on the returned id, so an ambiguous name still reverts precisely.
  return scans.find((s) => s.name === name) ?? null
}

/** Read a scan's editable `settings` from GET /scans/{id}; undefined on failure. */
export async function getScanSettings(
  client: TenableClient,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  const res = await client.request('GET', `/scans/${id}`)
  if (!res.ok) return undefined
  const detail = parseJson<{ settings?: Record<string, unknown> }>(res.body)
  return detail?.settings ?? undefined
}

/**
 * Build the Scans API create/update body. The top-level `uuid` is the SCAN
 * TEMPLATE uuid (from GET /editor/scan/templates), NOT the scan's own uuid;
 * everything else lives inside `settings`.
 */
export function buildScanBody(spec: ScanSpec): Record<string, unknown> {
  return { uuid: spec.templateUuid, settings: buildScanSettings(spec) }
}

/**
 * Assemble the `settings` object per the Scans API rules. text_targets is a
 * comma-separated STRING; a scheduled scan carries the rrules STRING and the
 * compact starttime, while an ON_DEMAND scan omits both.
 */
export function buildScanSettings(spec: ScanSpec): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    name: spec.name,
    enabled: spec.enabled,
    text_targets: spec.textTargets,
    launch: spec.launch,
  }
  if (spec.description) settings.description = spec.description
  if (spec.policyId !== undefined) settings.policy_id = spec.policyId
  if (spec.timezone) settings.timezone = spec.timezone

  if (spec.launch !== 'ON_DEMAND') {
    const rrules = assembleRrules(spec.launch, spec.interval ?? 1, spec.byday)
    if (rrules) settings.rrules = rrules
    if (spec.starttime) settings.starttime = spec.starttime
  }

  return settings
}
