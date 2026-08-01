import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem, normalizeSetting } from './_shared'

/**
 * Validate org security configuration items: a non-empty org + name, and the
 * feature dependencies GitHub itself enforces surfaced early as warnings:
 *   - push protection requires secret scanning
 *   - Dependabot alerts require the dependency graph
 *   - Dependabot security updates require Dependabot alerts
 *   - selected attach scope requires at least one repository id
 * Static — no target access required. (org, name) is the identity, so a
 * duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one configuration.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)

    if (!desired.org) {
      errors.push({ field: `items[${i}].org`, message: 'Organization is required.', code: 'EMPTY_ORG' })
    }
    if (!desired.name) {
      errors.push({ field: `items[${i}].name`, message: 'Configuration name is required.', code: 'EMPTY_NAME' })
    }

    if (desired.org && desired.name) {
      const key = `${desired.org.toLowerCase()}/${desired.name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Configuration ${desired.org}/${desired.name} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_CONFIGURATION',
        })
      } else {
        seen.add(key)
      }
    }

    const f = desired.features
    if (f.secret_scanning_push_protection === 'enabled' && f.secret_scanning !== 'enabled') {
      warnings.push({
        field: `items[${i}].secret_scanning_push_protection`,
        message: 'Push protection requires secret scanning — enable secret scanning too.',
        code: 'PUSH_PROTECTION_WITHOUT_SECRET_SCANNING',
      })
    }
    if (f.dependabot_alerts === 'enabled' && f.dependency_graph === 'disabled') {
      warnings.push({
        field: `items[${i}].dependabot_alerts`,
        message: 'Dependabot alerts require the dependency graph — do not disable the dependency graph.',
        code: 'ALERTS_WITHOUT_DEPENDENCY_GRAPH',
      })
    }
    if (f.dependabot_security_updates === 'enabled' && f.dependabot_alerts === 'disabled') {
      warnings.push({
        field: `items[${i}].dependabot_security_updates`,
        message: 'Dependabot security updates require Dependabot alerts — do not disable alerts.',
        code: 'UPDATES_WITHOUT_ALERTS',
      })
    }

    if (desired.attachScope === 'selected' && desired.selectedRepositoryIds.length === 0) {
      warnings.push({
        field: `items[${i}].selected_repository_ids`,
        message: 'Attach scope is "Selected repositories" but no repository ids are listed — nothing will be attached.',
        code: 'SELECTED_WITHOUT_IDS',
      })
    }

    for (const [key, value] of Object.entries(desired.additionalSettings)) {
      if (!normalizeSetting(value)) {
        warnings.push({
          field: `items[${i}].additional_settings`,
          message: `Additional setting "${key}" should be one of enabled | disabled | not_set (got "${value}").`,
          code: 'INVALID_ADDITIONAL_SETTING',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
