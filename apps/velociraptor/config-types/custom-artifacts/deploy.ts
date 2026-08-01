import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { artifactSetVQL, artifactDefinitionsVQL } from '../../lib/velociraptorApi'
import {
  buildClient,
  artifactsFromRows,
  findArtifact,
  definitionOf,
  vqlTimeoutMs,
  type Artifact,
} from './_shared'

/**
 * Deploy Velociraptor custom artifacts over the gRPC API (mutual TLS) by running
 * VQL:
 *   read (rollback): SELECT * FROM artifact_definitions(names=[...])  — prior YAML
 *   upsert:          SELECT artifact_set(definition=<yaml>) FROM scope()
 *
 * The artifact name is the stable identity. rollbackData records, per artifact,
 * the PRIOR definition YAML (null when it did not exist) so rollback can restore
 * it or delete the one we created.
 *
 * VERIFY against a live Velociraptor server: artifact_set() upsert semantics and
 * the artifact_definitions() raw-source column (flagged in lib/velociraptorApi.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for custom-artifact deployment' }
  }

  const previous: Array<{ name: string; definition: string | null }> = []
  const applied: string[] = []
  const timeoutMs = vqlTimeoutMs(settings)

  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    const names = items.map((item) => String(item.fields.name ?? '').trim()).filter(Boolean)
    let live: Artifact[] = []
    try {
      live = artifactsFromRows(await client.runVQL(artifactDefinitionsVQL(names), { timeoutMs }))
    } catch {
      live = [] // best-effort: without prior state, created artifacts roll back via delete
    }

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const definition = String(item.fields.definition ?? '')
      if (!name || !definition.trim()) continue

      const existing = findArtifact(live, name)
      previous.push({ name, definition: existing ? definitionOf(existing) || null : null })

      await client.runVQL(artifactSetVQL(definition), { timeoutMs })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom artifact(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom-artifact deploy failed after ${applied.length} artifact(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } finally {
    await client.close().catch(() => {})
  }
}
