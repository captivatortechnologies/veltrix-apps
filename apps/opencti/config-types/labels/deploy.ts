import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_LABEL_MUTATION,
  LIST_LABELS_QUERY,
  PATCH_LABEL_MUTATION,
  buildLabelInput,
  buildLabelPatch,
  findLabel,
  labelsFromList,
  type OpenctiLabel,
} from './_shared'

/**
 * Deploy OpenCTI labels over the GraphQL API:
 *   read (rollback): labels          → find the live label by value
 *   create:          labelAdd(input) with { value, color? }
 *   update:          labelFieldPatch(id, input) with [EditInput] (label exists)
 *
 * The `value` is the stable identity used to upsert. rollbackData records, per
 * label, the prior label node (null when it did not exist) AND the label id — so
 * rollback can restore the prior body or delete the one we created.
 *
 * NOTE: labelAdd returns the created label (with its new id). Verify the operation
 * names + field shapes against a live OpenCTI instance.
 */
async function listLabels(base: string, headers: Record<string, string>): Promise<OpenctiLabel[]> {
  try {
    return labelsFromList(await graphql<unknown>(base, headers, LIST_LABELS_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for label deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ value: string; labelId: string | null; label: OpenctiLabel | null }> = []
  const applied: string[] = []

  try {
    const live = await listLabels(base, headers)

    for (const item of items) {
      const value = String(item.fields.value ?? '').trim()
      if (!value) continue

      const existing = findLabel(live, value)

      if (existing && existing.id != null) {
        const input = buildLabelPatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_LABEL_MUTATION, { id: existing.id, input })
        }
        previous.push({ value, labelId: String(existing.id), label: existing })
      } else {
        const created = await graphql<{ labelAdd?: OpenctiLabel }>(base, headers, ADD_LABEL_MUTATION, {
          input: buildLabelInput(item.fields),
        })
        const newId = created?.labelAdd?.id ?? null
        previous.push({ value, labelId: newId ? String(newId) : null, label: null })
      }
      applied.push(value)
    }

    return {
      success: true,
      message: `Applied ${applied.length} label(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Label deploy failed after ${applied.length} label(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
