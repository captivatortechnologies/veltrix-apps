import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  extractAutomationActionSpecs,
  parseActionData,
  parseNameList,
  VALID_ACTION_CLASSIFICATIONS,
  VALID_ACTION_TYPES,
} from './_shared'

/**
 * Validate automation action items. Static — no target access required:
 *   - name is required and unique across the canvas (its reconciliation identity)
 *   - description is required (the PagerDuty API rejects a new action without one)
 *   - action_type is required and must be "script" or "process_automation"
 *   - action_data must parse to a JSON object with the required sub-field for
 *     the chosen action_type ("script" needs script; "process_automation"
 *     needs process_automation_job_id)
 *   - action_classification, when supplied, must be "diagnostic" or "remediation"
 *   - teams / services, when supplied, must each parse to a JSON array of
 *     non-empty name strings
 *   - a non-empty services list is a warning (not an error) when
 *     map_to_all_services is checked — it will be ignored at deploy
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractAutomationActionSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one automation action.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Automation action name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(spec.name.toLowerCase())) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Automation action name "${spec.name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (!spec.description) {
      errors.push({
        field: `${prefix}.description`,
        message: 'Description is required — the PagerDuty API rejects a new action without one.',
        code: 'EMPTY_DESCRIPTION',
      })
    }

    if (!spec.actionType) {
      errors.push({ field: `${prefix}.action_type`, message: 'Action Type is required.', code: 'EMPTY_ACTION_TYPE' })
    } else if (!VALID_ACTION_TYPES.has(spec.actionType)) {
      errors.push({
        field: `${prefix}.action_type`,
        message: `Action Type must be one of ${[...VALID_ACTION_TYPES].join(' / ')}.`,
        code: 'INVALID_ACTION_TYPE',
      })
    } else {
      const dataParsed = parseActionData(spec.actionDataJson, spec.actionType)
      if (dataParsed.error) {
        errors.push({ field: `${prefix}.action_data`, message: `Action Data ${dataParsed.error}.`, code: 'INVALID_ACTION_DATA' })
      }
    }

    if (spec.actionClassification && !VALID_ACTION_CLASSIFICATIONS.has(spec.actionClassification)) {
      errors.push({
        field: `${prefix}.action_classification`,
        message: `Classification must be one of ${[...VALID_ACTION_CLASSIFICATIONS].join(' / ')}.`,
        code: 'INVALID_ACTION_CLASSIFICATION',
      })
    }

    const teamsParsed = parseNameList(spec.teamsJson, 'team')
    if (teamsParsed.error) {
      errors.push({ field: `${prefix}.teams`, message: `Teams ${teamsParsed.error}.`, code: 'INVALID_TEAMS' })
    }

    const servicesParsed = parseNameList(spec.servicesJson, 'service')
    if (servicesParsed.error) {
      errors.push({ field: `${prefix}.services`, message: `Services ${servicesParsed.error}.`, code: 'INVALID_SERVICES' })
    } else if (spec.mapToAllServices && servicesParsed.names && servicesParsed.names.length > 0) {
      warnings.push({
        field: `${prefix}.services`,
        message: 'Services is ignored when "Applies to All Services" is checked and will not be sent.',
        code: 'IGNORED_SERVICES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
