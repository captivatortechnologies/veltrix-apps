import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ARTIFACT_TYPES, looksLikeArtifactYaml, extractYamlName, extractYamlType } from './_shared'

/**
 * Validate custom-artifact items: a valid name, a known type, and a non-empty
 * definition that passes basic YAML sanity. Static — no target access required.
 * The artifact name is the identity used to upsert, so a duplicate name is flagged
 * (last one wins). When the definition declares its own name:/type:, a mismatch
 * against the item's name/type fields is warned (the definition's name is what the
 * server keys on).
 */
const NAME_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/

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
    } else if (!NAME_RE.test(name)) {
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
      const sanity = looksLikeArtifactYaml(definition)
      if (!sanity.ok) {
        errors.push({ field: `items[${i}].definition`, message: `Invalid artifact definition: ${sanity.reason}.`, code: 'INVALID_DEFINITION' })
      } else {
        const yamlName = extractYamlName(definition)
        if (name && yamlName && yamlName !== name) {
          warnings.push({
            field: `items[${i}].definition`,
            message: `Definition name: "${yamlName}" does not match the item name "${name}" — the server keys on the definition's name.`,
            code: 'NAME_MISMATCH',
          })
        }
        const yamlType = extractYamlType(definition)
        if (type && yamlType && yamlType !== type) {
          warnings.push({
            field: `items[${i}].definition`,
            message: `Definition type: "${yamlType}" does not match the selected type "${type}".`,
            code: 'TYPE_MISMATCH',
          })
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
