import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { artifactDefinitionsVQL } from '../../lib/velociraptorApi'
import {
  buildClient,
  artifactsFromRows,
  findArtifact,
  definitionOf,
  normalizeDefinition,
  vqlTimeoutMs,
  type Artifact,
} from './_shared'

/**
 * Drift for custom artifacts: compare the definition YAML we declare against the
 * live artifact stored on the server. Best-effort — an artifact we can't read
 * (missing / transient error) is skipped rather than raising false drift.
 * Read-only: SELECT * FROM artifact_definitions(names=[...]).
 *
 * VERIFY against a live Velociraptor server: artifact_definitions() raw-source column.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch {
    return { hasDrift: false, diffs } // can't build client → no drift asserted
  }

  try {
    const names = items.map((item) => String(item.fields.name ?? '').trim()).filter(Boolean)
    let live: Artifact[]
    try {
      live = artifactsFromRows(await client.runVQL(artifactDefinitionsVQL(names), { timeoutMs: vqlTimeoutMs(settings) }))
    } catch {
      return { hasDrift: false, diffs } // best-effort: can't read artifacts, no drift asserted
    }

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const desired = String(item.fields.definition ?? '')
      const match = findArtifact(live, name)

      if (!match) {
        diffs.push({ field: `${name}.presence`, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDefinition = definitionOf(match)
      if (liveDefinition && normalizeDefinition(liveDefinition) !== normalizeDefinition(desired)) {
        diffs.push({ field: `${name}.definition`, expected: 'declared definition', actual: 'server definition differs', severity: 'warning' })
      }
    }

    return { hasDrift: diffs.length > 0, diffs }
  } finally {
    await client.close().catch(() => {})
  }
}
