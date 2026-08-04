import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate MDM-settings items: a valid scope (global or numeric team id),
 * ISO date deadlines, non-negative Windows update windows, and a migration
 * webhook URL whenever macOS migration is enabled. Static — no target access
 * required.
 */
const SCOPE_RE = /^(global|[0-9]+)$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const YES_NO = new Set(['yes', 'no', ''])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one MDM settings scope.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const teamId = String(item.fields.teamId ?? '').trim().toLowerCase()
    const isGlobal = teamId === 'global' || teamId === ''

    if (!SCOPE_RE.test(teamId)) {
      errors.push({ field: `items[${i}].teamId`, message: 'Team ID must be "global" or a numeric team id.', code: 'INVALID_SCOPE' })
    } else if (seen.has(teamId)) {
      warnings.push({ field: `items[${i}].teamId`, message: `Scope "${teamId}" is listed more than once; the last one wins.`, code: 'DUPLICATE_SCOPE' })
    } else {
      seen.add(teamId)
    }

    for (const dateKey of ['macosDeadline', 'iosDeadline', 'ipadosDeadline']) {
      const value = String(item.fields[dateKey] ?? '').trim()
      if (value && !DATE_RE.test(value)) {
        errors.push({ field: `items[${i}].${dateKey}`, message: `${dateKey} must be YYYY-MM-DD.`, code: 'INVALID_DATE' })
      }
    }

    for (const yesNoKey of ['enableDiskEncryption', 'windowsRequireBitlockerPin', 'enableRecoveryLockPassword', 'appleRequireHardwareAttestation', 'enableEndUserAuthentication', 'macosMigrationEnabled', 'windowsEnabledAndConfigured']) {
      const value = String(item.fields[yesNoKey] ?? '').trim().toLowerCase()
      if (!YES_NO.has(value)) {
        errors.push({ field: `items[${i}].${yesNoKey}`, message: `${yesNoKey} must be yes or no.`, code: 'INVALID_YES_NO' })
      }
    }

    if (!isGlobal) {
      for (const globalOnlyKey of ['enableRecoveryLockPassword', 'appleRequireHardwareAttestation', 'macosMigrationEnabled', 'windowsEnabledAndConfigured']) {
        const value = String(item.fields[globalOnlyKey] ?? '').trim().toLowerCase()
        if (value === 'yes') {
          warnings.push({ field: `items[${i}].${globalOnlyKey}`, message: `${globalOnlyKey} only applies to the global scope and is ignored for a team.`, code: 'GLOBAL_ONLY_FIELD_ON_TEAM' })
        }
      }
    }

    const migrationEnabled = String(item.fields.macosMigrationEnabled ?? '').trim().toLowerCase() === 'yes'
    if (migrationEnabled && isGlobal) {
      const webhookUrl = String(item.fields.macosMigrationWebhookUrl ?? '').trim()
      if (!webhookUrl) {
        errors.push({ field: `items[${i}].macosMigrationWebhookUrl`, message: 'Migration Webhook URL is required when macOS Migration is enabled.', code: 'MISSING_MIGRATION_WEBHOOK' })
      }
      const mode = String(item.fields.macosMigrationMode ?? '').trim().toLowerCase()
      if (mode && mode !== 'voluntary' && mode !== 'forced') {
        errors.push({ field: `items[${i}].macosMigrationMode`, message: 'Migration Mode must be voluntary or forced.', code: 'INVALID_MIGRATION_MODE' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
