import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import { ALL_CLIENTS_LABEL } from './_shared'
import { validArtifactName } from '../../lib/artifactName'

/**
 * Validate client-monitoring groups: each needs a label (identity) and, when
 * enabled, at least one event artifact. Static — no target access required. The
 * label is the upsert identity, so a duplicate label is flagged (last one wins).
 * Every artifact name (enabled or not — a disabled group's list is kept authored
 * so re-enabling restores it) must match Velociraptor's dotted artifact-name
 * format; a malformed name is rejected rather than silently sent to the server.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client monitoring group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const label = String(item.fields.label ?? '').trim() || ALL_CLIENTS_LABEL
    const enabled = asBool(item.fields.enabled, true)
    const artifacts = splitList(item.fields.artifacts)

    const key = label.toLowerCase()
    if (seen.has(key)) {
      warnings.push({ field: `items[${i}].label`, message: `Label group "${label}" is listed more than once; the last one wins.`, code: 'DUPLICATE_LABEL' })
    } else {
      seen.add(key)
    }

    if (enabled && artifacts.length === 0) {
      errors.push({
        field: `items[${i}].artifacts`,
        message: `Enabled label group "${label}" needs at least one event artifact.`,
        code: 'EMPTY_ARTIFACTS',
      })
    }

    for (const artifactName of artifacts) {
      if (!validArtifactName(artifactName)) {
        errors.push({
          field: `items[${i}].artifacts`,
          message: `Event artifact name "${artifactName}" in group "${label}" must be dotted alphanumeric, e.g. Windows.Events.ProcessCreation.`,
          code: 'INVALID_ARTIFACT_NAME',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
