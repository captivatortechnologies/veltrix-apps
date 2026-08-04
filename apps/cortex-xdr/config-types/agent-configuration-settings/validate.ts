import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readOptionalInt, readKeyValueMap } from '../../lib/fields'
import { TIME_INTERVAL_HOURS_OPTIONS } from './_shared'

/**
 * Validate the Agent Configuration Settings singleton: at most one declared
 * item, every documented range constraint (bandwidth, license/retention
 * periods, parallel-upgrade count), a known time_interval_hours enum value when
 * provided, and every action_center_expiration value a positive integer. Static
 * — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the Agent Configuration Settings item.', code: 'EMPTY' })
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Agent Configuration Settings is a singleton — declare it only once per canvas.', code: 'SINGLETON' })
  }

  items.forEach((item, i) => {
    const fields = item.fields

    const bandwidth = readOptionalInt(fields.bandwidth_in_mbps)
    if (bandwidth !== undefined && (bandwidth < 20 || bandwidth > 10000)) {
      errors.push({ field: `items[${i}].bandwidth_in_mbps`, message: 'Bandwidth must be between 20 and 10000 Mbps.', code: 'INVALID_BANDWIDTH' })
    }

    const revocation = readOptionalInt(fields.license_revocation_after_lost_connection)
    if (revocation !== undefined && (revocation < 2 || revocation > 60)) {
      errors.push({ field: `items[${i}].license_revocation_after_lost_connection`, message: 'License revocation period must be between 2 and 60 days.', code: 'INVALID_LICENSE_REVOCATION' })
    }

    const retention = readOptionalInt(fields.agent_deletion_retention)
    if (retention !== undefined && (retention < 3 || retention > 360)) {
      errors.push({ field: `items[${i}].agent_deletion_retention`, message: 'Agent deletion retention must be between 3 and 360 days.', code: 'INVALID_AGENT_DELETION_RETENTION' })
    }
    if (revocation !== undefined && retention !== undefined && retention <= revocation) {
      warnings.push({ field: `items[${i}].agent_deletion_retention`, message: 'Agent deletion retention should be greater than the license revocation period, per Cortex XDR guidance.', code: 'RETENTION_NOT_GREATER_THAN_REVOCATION' })
    }

    const parallelUpgrades = readOptionalInt(fields.amount_of_parallel_upgrades)
    if (parallelUpgrades !== undefined && (parallelUpgrades < 1 || parallelUpgrades > 2000)) {
      errors.push({ field: `items[${i}].amount_of_parallel_upgrades`, message: 'Parallel upgrades must be between 1 and 2000.', code: 'INVALID_PARALLEL_UPGRADES' })
    }

    const timeIntervalRaw = fields.time_interval_hours
    if (timeIntervalRaw !== undefined && timeIntervalRaw !== '') {
      const timeInterval = readOptionalInt(timeIntervalRaw)
      if (timeInterval === undefined || !TIME_INTERVAL_HOURS_OPTIONS.has(timeInterval)) {
        errors.push({ field: `items[${i}].time_interval_hours`, message: `Time interval must be one of ${[...TIME_INTERVAL_HOURS_OPTIONS].join(', ')} hours (got "${String(timeIntervalRaw)}").`, code: 'INVALID_TIME_INTERVAL' })
      }
    }

    for (const [key, value] of Object.entries(readKeyValueMap(fields.action_center_expiration))) {
      const hours = readOptionalInt(value)
      if (hours === undefined || hours <= 0) {
        errors.push({ field: `items[${i}].action_center_expiration`, message: `Action "${key}" expiration must be a positive integer number of hours (got "${value}").`, code: 'INVALID_ACTION_EXPIRATION' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
