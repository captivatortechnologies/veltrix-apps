import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseRepository, normalizeBool } from './_shared'

/**
 * Validate repository-security items: a non-empty `owner/repo`, and the feature
 * dependencies GitHub itself enforces surfaced early as warnings:
 *   - push protection requires secret scanning
 *   - on private repos, secret scanning / code scanning require Advanced Security
 * Static — no target access required. The repository doubles as the identity, so a
 * duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one repository.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const repository = String(item.fields.repository ?? '').trim()
    const parsed = parseRepository(repository)

    if (!repository) {
      errors.push({ field: `items[${i}].repository`, message: 'Repository is required.', code: 'EMPTY_REPOSITORY' })
    } else if (!parsed) {
      errors.push({
        field: `items[${i}].repository`,
        message: `Repository must be in "owner/repo" form (got "${repository}").`,
        code: 'INVALID_REPOSITORY',
      })
    } else {
      const key = repository.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].repository`,
          message: `Repository ${repository} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_REPOSITORY',
        })
      } else {
        seen.add(key)
      }
    }

    const secretScanning = normalizeBool(item.fields.secret_scanning)
    const pushProtection = normalizeBool(item.fields.secret_scanning_push_protection)
    const advancedSecurity = normalizeBool(item.fields.advanced_security)
    const codeScanning = normalizeBool(item.fields.code_scanning_default_setup)

    if (pushProtection && !secretScanning) {
      warnings.push({
        field: `items[${i}].secret_scanning_push_protection`,
        message: 'Push protection requires secret scanning — enable secret scanning too, or GitHub may reject it.',
        code: 'PUSH_PROTECTION_WITHOUT_SECRET_SCANNING',
      })
    }
    if ((secretScanning || codeScanning) && !advancedSecurity) {
      warnings.push({
        field: `items[${i}].advanced_security`,
        message:
          'On a private repository, secret scanning and code scanning require GitHub Advanced Security — ' +
          'enable Advanced Security too if this repo is private.',
        code: 'FEATURE_WITHOUT_ADVANCED_SECURITY',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
