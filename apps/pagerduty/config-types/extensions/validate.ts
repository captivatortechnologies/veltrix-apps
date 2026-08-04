import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractExtensionSpecs, looksLikeUrl, parseExtensionConfig, parseExtensionObjects } from './_shared'

/**
 * Validate extension items. Static — no target access required:
 *   - name is required and unique across the canvas (its reconciliation identity)
 *   - extension_schema (the referenced schema NAME) is required; deploy resolves
 *     it to an id against the live account
 *   - endpoint_url, when supplied, must look like an http(s) URL — PagerDuty
 *     itself decides whether a given schema requires one; a schema that does
 *     and gets a blank endpoint_url fails at deploy time with a normal error
 *   - extension_objects must parse to a non-empty JSON array of non-empty
 *     service-name strings
 *   - config, when supplied, must parse to a JSON object
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractExtensionSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one extension.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Extension name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(spec.name.toLowerCase())) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Extension name "${spec.name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (!spec.extensionSchemaName) {
      errors.push({
        field: `${prefix}.extension_schema`,
        message: 'An extension schema name is required — every extension must reference one.',
        code: 'EMPTY_EXTENSION_SCHEMA',
      })
    }

    if (spec.endpointUrl && !looksLikeUrl(spec.endpointUrl)) {
      errors.push({
        field: `${prefix}.endpoint_url`,
        message: `Endpoint URL "${spec.endpointUrl}" does not look like a well-formed http(s) URL.`,
        code: 'INVALID_ENDPOINT_URL',
      })
    }

    const objectsParsed = parseExtensionObjects(spec.extensionObjectsJson)
    if (objectsParsed.error) {
      errors.push({
        field: `${prefix}.extension_objects`,
        message: `Extension objects ${objectsParsed.error}.`,
        code: 'INVALID_EXTENSION_OBJECTS',
      })
    }

    const configParsed = parseExtensionConfig(spec.configJson)
    if (configParsed.error) {
      errors.push({ field: `${prefix}.config`, message: `Config ${configParsed.error}.`, code: 'INVALID_CONFIG' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
