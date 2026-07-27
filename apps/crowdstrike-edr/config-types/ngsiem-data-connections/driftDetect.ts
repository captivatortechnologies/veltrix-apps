import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findByName, listDataConnections } from './deploy'
import {
  extractConnectionSpecs,
  liveRepository,
  liveStatus,
  STATUS_DISABLED,
  STATUS_ENABLED,
} from './validate'

/**
 * Detect drift between the deployed data connection configuration and the live
 * tenant state. Compares ONLY non-secret fields — connector_type and parser
 * (verified fields), plus repository and status best-effort when the live entity
 * reports them. The upstream credential (and the Falcon ingest token) is NEVER
 * read, compared, or surfaced. The source endpoint is not diffed either — it can
 * carry secret-adjacent auth params.
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

  const specs = extractConnectionSpecs(ctx.deployedConfig).filter(
    (s) => s.name && s.connectorType && s.targetRepository,
  )
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: Awaited<ReturnType<typeof listDataConnections>> = []
  try {
    live = await listDataConnections(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'connections',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    const before = diffs.length
    const found = findByName(live, spec.name)

    if (!found) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    // connector_type — the catalog connector (verified field, always compared)
    if ((found.connector_type ?? '') !== spec.connectorType) {
      diffs.push({
        field: `${spec.name}.connectorType`,
        expected: spec.connectorType,
        actual: found.connector_type ?? 'not set',
        severity: 'warning',
      })
    }

    // parser — compared only when declared; a blank parser accepts the connector
    // default, so an assigned default is not treated as drift.
    if (spec.parser !== undefined && (found.parser ?? '') !== spec.parser) {
      diffs.push({
        field: `${spec.name}.parser`,
        expected: spec.parser,
        actual: found.parser ?? 'not set',
        severity: 'warning',
      })
    }

    // repository / status — best-effort: only flag when the live entity reports
    // the field, so an unmodeled field name never produces false drift.
    const foundRepository = liveRepository(found)
    if (foundRepository !== undefined && foundRepository !== spec.targetRepository) {
      diffs.push({
        field: `${spec.name}.targetRepository`,
        expected: spec.targetRepository,
        actual: foundRepository,
        severity: 'warning',
      })
    }

    const foundStatus = liveStatus(found)
    if (foundStatus !== undefined) {
      const expectedStatus = spec.enabled ? STATUS_ENABLED : STATUS_DISABLED
      if (foundStatus !== expectedStatus) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: expectedStatus,
          actual: foundStatus,
          severity: 'warning',
        })
      }
    }

    // Attribute every diff this connection produced to Falcon's recorded last
    // modifier (once) — no-op when nothing drifted or the change was ours.
    attachDriftActor(diffs.slice(before), found, { excludeActorLogins })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
