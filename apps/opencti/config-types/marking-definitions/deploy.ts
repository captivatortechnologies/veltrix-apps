import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_MARKING_MUTATION,
  LIST_MARKINGS_QUERY,
  PATCH_MARKING_MUTATION,
  buildMarkingInput,
  buildMarkingPatch,
  findMarking,
  markingsFromList,
  type OpenctiMarking,
} from './_shared'

/**
 * Deploy OpenCTI marking definitions over the GraphQL API:
 *   read (rollback): markingDefinitions        → find the live marking by definition
 *   create:          markingDefinitionAdd(input) with { definition_type, definition, color?, order? }
 *   update:          markingDefinitionFieldPatch(id, input) with [EditInput] (marking exists)
 *
 * The `definition` value is the stable identity used to upsert. rollbackData records,
 * per marking, the prior marking node (null when it did not exist) AND the marking
 * id — so rollback can restore the prior body or delete the one we created.
 *
 * NOTE: markingDefinitionAdd returns the created marking (with its new id). Verify
 * the operation names + field shapes against a live OpenCTI instance.
 */
async function listMarkings(base: string, headers: Record<string, string>): Promise<OpenctiMarking[]> {
  try {
    return markingsFromList(await graphql<unknown>(base, headers, LIST_MARKINGS_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for marking-definition deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ definition: string; markingId: string | null; marking: OpenctiMarking | null }> = []
  const applied: string[] = []

  try {
    const live = await listMarkings(base, headers)

    for (const item of items) {
      const definition = String(item.fields.definition ?? '').trim()
      if (!definition) continue

      const existing = findMarking(live, definition)

      if (existing && existing.id != null) {
        await graphql(base, headers, PATCH_MARKING_MUTATION, { id: existing.id, input: buildMarkingPatch(item.fields) })
        previous.push({ definition, markingId: String(existing.id), marking: existing })
      } else {
        const created = await graphql<{ markingDefinitionAdd?: OpenctiMarking }>(
          base,
          headers,
          ADD_MARKING_MUTATION,
          { input: buildMarkingInput(item.fields) },
        )
        const newId = created?.markingDefinitionAdd?.id ?? null
        previous.push({ definition, markingId: newId ? String(newId) : null, marking: null })
      }
      applied.push(definition)
    }

    return {
      success: true,
      message: `Applied ${applied.length} marking definition(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Marking-definition deploy failed after ${applied.length} marking(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
