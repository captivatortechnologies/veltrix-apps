import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseRuleKeys, normalizeBool } from './_shared'

/**
 * Validate quality-profile items: a non-empty name and a non-empty language. The
 * (name, language) pair is the profile identity, so a duplicate pair is flagged (last
 * one wins). A profile cannot be its own parent. Rule keys must look like
 * `<repository>:<rule>`. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one quality profile.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  const defaultsByLanguage = new Map<string, number>()

  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const language = String(item.fields.language ?? '').trim()
    const parentName = String(item.fields.parentName ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Quality profile name is required.', code: 'EMPTY_NAME' })
    }
    if (!language) {
      errors.push({ field: `items[${i}].language`, message: 'Language is required (e.g. java, js, py, cs).', code: 'EMPTY_LANGUAGE' })
    }

    if (name && language) {
      const identity = `${name}::${language.toLowerCase()}`
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].name`, message: `Quality profile "${name}" (${language}) is listed more than once; the last one wins.`, code: 'DUPLICATE_PROFILE' })
      } else {
        seen.add(identity)
      }
    }

    if (parentName && name && parentName === name) {
      errors.push({ field: `items[${i}].parentName`, message: 'A quality profile cannot be its own parent.', code: 'SELF_PARENT' })
    }

    const { malformed } = parseRuleKeys(item.fields.activateRuleKeys)
    for (const bad of malformed) {
      warnings.push({ field: `items[${i}].activateRuleKeys`, message: `Rule key "${bad}" is ignored — expected "<repository>:<rule>", e.g. java:S1067.`, code: 'MALFORMED_RULE_KEY' })
    }

    if (normalizeBool(item.fields.isDefault) && language) {
      const key = language.toLowerCase()
      defaultsByLanguage.set(key, (defaultsByLanguage.get(key) ?? 0) + 1)
    }
  })

  for (const [language, count] of defaultsByLanguage) {
    if (count > 1) {
      warnings.push({ field: 'items', message: `${count} ${language} profiles are flagged default; SonarQube keeps one default per language, so the last applied wins.`, code: 'MULTIPLE_DEFAULT' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
