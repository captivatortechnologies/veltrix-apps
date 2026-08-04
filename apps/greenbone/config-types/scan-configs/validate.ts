import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_RE } from '../../lib/greenboneApi'
import { parseFamilySelectionField, parseNvtSelectionField, parsePreferencesField } from './_shared'

/**
 * Validate scan-config items: a non-empty name, a UUID-shaped base config to
 * clone, and (if provided) well-formed JSON for family/NVT selection and
 * preferences. Static — no gvmd access required. Config names double as the
 * upsert identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scan config.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const baseConfigId = String(item.fields.baseConfigId ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Scan config name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Scan config name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!baseConfigId) {
      errors.push({ field: `items[${i}].baseConfigId`, message: 'A base config to clone is required.', code: 'EMPTY_BASE_CONFIG' })
    } else if (!UUID_RE.test(baseConfigId)) {
      errors.push({ field: `items[${i}].baseConfigId`, message: `Base config "${baseConfigId}" must be a GMP config UUID.`, code: 'INVALID_BASE_CONFIG' })
    }

    const family = parseFamilySelectionField(item.fields.familySelection)
    if (family.error) {
      errors.push({ field: `items[${i}].familySelection`, message: `familySelection is not valid JSON: ${family.error}`, code: 'INVALID_FAMILY_SELECTION' })
    } else if (family.value) {
      family.value.forEach((f, fi) => {
        if (!f || typeof f !== 'object' || !String((f as { name?: unknown }).name ?? '').trim()) {
          errors.push({ field: `items[${i}].familySelection[${fi}]`, message: 'Each family selection entry needs a "name".', code: 'INVALID_FAMILY_SELECTION' })
        }
      })
    }

    const nvt = parseNvtSelectionField(item.fields.nvtSelection)
    if (nvt.error) {
      errors.push({ field: `items[${i}].nvtSelection`, message: `nvtSelection is not valid JSON: ${nvt.error}`, code: 'INVALID_NVT_SELECTION' })
    } else if (nvt.value) {
      nvt.value.forEach((n, ni) => {
        if (!n || typeof n !== 'object' || !String((n as { family?: unknown }).family ?? '').trim() || !Array.isArray((n as { oids?: unknown }).oids)) {
          errors.push({ field: `items[${i}].nvtSelection[${ni}]`, message: 'Each NVT selection entry needs a "family" and an "oids" array.', code: 'INVALID_NVT_SELECTION' })
        }
      })
    }

    const prefs = parsePreferencesField(item.fields.preferences)
    if (prefs.error) {
      errors.push({ field: `items[${i}].preferences`, message: `preferences is not valid JSON: ${prefs.error}`, code: 'INVALID_PREFERENCES' })
    } else if (prefs.value) {
      prefs.value.forEach((p, pi) => {
        if (!p || typeof p !== 'object' || !String((p as { name?: unknown }).name ?? '').trim() || (p as { value?: unknown }).value === undefined) {
          errors.push({ field: `items[${i}].preferences[${pi}]`, message: 'Each preference needs a "name" and a "value".', code: 'INVALID_PREFERENCES' })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
