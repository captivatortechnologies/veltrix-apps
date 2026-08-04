import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseParams, normalizeBool } from './_shared'

/**
 * Validate rule-override items: a non-empty profile name, language and rule key.
 * The (profileName, language, ruleKey) triple is the override's identity, so a
 * duplicate triple is flagged (last one wins). A rule key that doesn't look like
 * `<repository>:<rule>` is a WARNING (not a hard error) — SonarQube itself will
 * reject an invalid key at deploy time, mirroring quality-profiles' treatment of a
 * malformed rule key. `reset=true` alongside severity/params/prioritizedRule is a
 * warning, since reset ignores them. Static — no target access required.
 */
const RULE_KEY_PATTERN = /^\S+:\S+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one rule override.', code: 'EMPTY' })
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const profileName = String(item.fields.profileName ?? '').trim()
    const language = String(item.fields.language ?? '').trim()
    const ruleKey = String(item.fields.ruleKey ?? '').trim()

    if (!profileName) {
      errors.push({ field: `items[${i}].profileName`, message: 'Quality profile name is required.', code: 'EMPTY_PROFILE' })
    }
    if (!language) {
      errors.push({ field: `items[${i}].language`, message: 'Language is required (e.g. java, js, py, cs).', code: 'EMPTY_LANGUAGE' })
    }
    if (!ruleKey) {
      errors.push({ field: `items[${i}].ruleKey`, message: 'Rule key is required.', code: 'EMPTY_RULE_KEY' })
    } else if (!RULE_KEY_PATTERN.test(ruleKey)) {
      warnings.push({
        field: `items[${i}].ruleKey`,
        message: `Rule key "${ruleKey}" should look like "<repository>:<rule>", e.g. java:S1067 — SonarQube will reject it at deploy time if it is not.`,
        code: 'INVALID_RULE_KEY',
      })
    }

    const { params, errors: paramErrors } = parseParams(item.fields.params)
    for (const pe of paramErrors) {
      errors.push({ field: `items[${i}].params`, message: pe.message, code: pe.code })
    }

    const reset = normalizeBool(item.fields.reset)
    const severity = String(item.fields.severity ?? '').trim()
    const prioritizedRule = normalizeBool(item.fields.prioritizedRule)
    if (reset && (severity || params.length > 0 || prioritizedRule)) {
      warnings.push({
        field: `items[${i}].reset`,
        message: 'reset=true ignores severity/params/prioritizedRule on this item.',
        code: 'IGNORED_ON_RESET',
      })
    }

    if (profileName && language && ruleKey) {
      const identity = `${profileName}::${language.toLowerCase()}::${ruleKey}`
      if (seen.has(identity)) {
        warnings.push({
          field: `items[${i}].ruleKey`,
          message: `Rule override for "${ruleKey}" in "${profileName}" (${language}) is listed more than once; the last one wins.`,
          code: 'DUPLICATE_OVERRIDE',
        })
      } else {
        seen.add(identity)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
