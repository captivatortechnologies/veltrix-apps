import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { POLICY_ENGINE_MODES, SLUG_PATTERN, readOptionalInt } from './_shared'

/**
 * Validate authentik Application items: a non-empty name, a slug matching
 * authentik's `^[-a-zA-Z0-9_]+$` pattern (the item's identity — also the
 * `{slug}` path segment), a known `policy_engine_mode`, and — when set — a
 * positive-integer `provider` pk. Static (no target access): the provider pk
 * is NOT resolved against a live authentik instance here — the referenced
 * provider must already exist; provider authoring is a separate config type
 * planned for a later wave. A duplicate slug is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one application.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const slug = String(item.fields.slug ?? '').trim()
    const policyMode = String(item.fields.policy_engine_mode ?? '').trim()
    const rawProvider = item.fields.provider

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Application name is required.', code: 'EMPTY_NAME' })
    }

    if (!slug) {
      errors.push({ field: `items[${i}].slug`, message: 'Slug is required.', code: 'EMPTY_SLUG' })
    } else if (!SLUG_PATTERN.test(slug)) {
      errors.push({
        field: `items[${i}].slug`,
        message: `Slug "${slug}" may only contain letters, numbers, hyphens and underscores.`,
        code: 'INVALID_SLUG',
      })
    } else if (seen.has(slug)) {
      warnings.push({
        field: `items[${i}].slug`,
        message: `Slug "${slug}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_SLUG',
      })
    } else {
      seen.add(slug)
    }

    if (policyMode && !POLICY_ENGINE_MODES.has(policyMode)) {
      errors.push({
        field: `items[${i}].policy_engine_mode`,
        message: `Policy engine mode must be "any" or "all" (got "${policyMode}").`,
        code: 'INVALID_POLICY_ENGINE_MODE',
      })
    }

    if (rawProvider != null && rawProvider !== '') {
      const provider = readOptionalInt(rawProvider)
      if (provider == null || provider <= 0) {
        errors.push({
          field: `items[${i}].provider`,
          message: `Provider must be a positive integer (an existing provider's pk); got "${String(rawProvider)}".`,
          code: 'INVALID_PROVIDER',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
