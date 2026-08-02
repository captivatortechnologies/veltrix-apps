import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ARTIFACT_TYPES, validateArtifactDefinition } from './_shared'
import { ARTIFACT_NAME_RE } from '../../lib/artifactName'

/**
 * Validate custom-artifact items: a valid name, a known type, and a definition
 * that parses as real YAML and matches Velociraptor's artifact schema shape
 * (validateArtifactDefinition, in _shared.ts). Static — no target access
 * required. The artifact name is the identity used to upsert, so a duplicate
 * name is flagged (last one wins). When the definition declares its own
 * name:/type:, a mismatch against the item's name/type fields is warned (the
 * definition's name is what the server keys on).
 */

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom artifact.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const definition = String(item.fields.definition ?? '')

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Artifact name is required.', code: 'EMPTY_NAME' })
    } else if (!ARTIFACT_NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Artifact name "${name}" must be dotted alphanumeric, e.g. Custom.Windows.Detection.Foo.`,
        code: 'INVALID_NAME',
      })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Artifact name ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!ARTIFACT_TYPES.has(type)) {
      errors.push({
        field: `items[${i}].type`,
        message: `Type must be one of CLIENT, SERVER, CLIENT_EVENT, SERVER_EVENT (got "${type}").`,
        code: 'INVALID_TYPE',
      })
    }

    if (!definition.trim()) {
      errors.push({ field: `items[${i}].definition`, message: 'Artifact definition is required.', code: 'EMPTY_DEFINITION' })
    } else {
      const check = validateArtifactDefinition(definition)
      if (!check.ok) {
        errors.push({ field: `items[${i}].definition`, message: `Invalid artifact definition: ${check.reason}.`, code: 'INVALID_DEFINITION' })
      } else {
        if (name && check.name && check.name !== name) {
          warnings.push({
            field: `items[${i}].definition`,
            message: `Definition name: "${check.name}" does not match the item name "${name}" — the server keys on the definition's name.`,
            code: 'NAME_MISMATCH',
          })
        }
        if (type && check.type && check.type !== type) {
          warnings.push({
            field: `items[${i}].definition`,
            message: `Definition type: "${check.type}" does not match the selected type "${type}".`,
            code: 'TYPE_MISMATCH',
          })
        }
        for (const warning of check.warnings) {
          warnings.push({ field: `items[${i}].definition`, message: `${warning}.`, code: 'COLLECTS_NOTHING' })
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
