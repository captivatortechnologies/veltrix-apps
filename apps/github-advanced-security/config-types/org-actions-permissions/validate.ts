import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem, ENABLED_REPOSITORIES_VALUES, ALLOWED_ACTIONS_VALUES, WORKFLOW_PERMISSIONS_VALUES } from './_shared'

/**
 * Validate org-actions-permissions items: a non-empty org, valid enums, and
 * warnings for scope-dependent fields left empty. Static — no target access
 * required. The org doubles as the identity, so a duplicate is flagged (last
 * one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one organization.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)

    if (!desired.org) {
      errors.push({ field: `items[${i}].org`, message: 'Organization is required.', code: 'EMPTY_ORG' })
    } else {
      const key = desired.org.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].org`, message: `Organization ${desired.org} is listed more than once; the last one wins.`, code: 'DUPLICATE_ORG' })
      } else {
        seen.add(key)
      }
    }

    if (!ENABLED_REPOSITORIES_VALUES.includes(desired.enabledRepositories as (typeof ENABLED_REPOSITORIES_VALUES)[number])) {
      errors.push({ field: `items[${i}].enabled_repositories`, message: `Enabled repositories must be one of ${ENABLED_REPOSITORIES_VALUES.join(', ')}.`, code: 'INVALID_ENABLED_REPOSITORIES' })
    }
    if (!ALLOWED_ACTIONS_VALUES.includes(desired.allowedActions as (typeof ALLOWED_ACTIONS_VALUES)[number])) {
      errors.push({ field: `items[${i}].allowed_actions`, message: `Allowed actions must be one of ${ALLOWED_ACTIONS_VALUES.join(', ')}.`, code: 'INVALID_ALLOWED_ACTIONS' })
    }
    if (!WORKFLOW_PERMISSIONS_VALUES.includes(desired.defaultWorkflowPermissions as (typeof WORKFLOW_PERMISSIONS_VALUES)[number])) {
      errors.push({ field: `items[${i}].default_workflow_permissions`, message: `Default workflow permissions must be one of ${WORKFLOW_PERMISSIONS_VALUES.join(', ')}.`, code: 'INVALID_WORKFLOW_PERMISSIONS' })
    }

    if (desired.enabledRepositories === 'selected' && desired.selectedRepositoryIds.length === 0) {
      warnings.push({
        field: `items[${i}].selected_repository_ids`,
        message: 'Enabled repositories is "Selected" but no repository ids are listed — no repository will be able to run Actions.',
        code: 'SELECTED_REPOSITORIES_WITHOUT_IDS',
      })
    }
    if (desired.allowedActions === 'selected' && !desired.githubOwnedAllowed && !desired.verifiedAllowed && desired.patternsAllowed.length === 0) {
      warnings.push({
        field: `items[${i}].patterns_allowed`,
        message: 'Allowed actions is "Selected" but nothing is allowed (no GitHub-owned, no verified, no patterns) — no action will be able to run.',
        code: 'SELECTED_ACTIONS_WITHOUT_ANY_ALLOWANCE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
