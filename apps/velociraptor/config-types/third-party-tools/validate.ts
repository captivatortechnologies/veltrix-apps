import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

const SHA256_HEX_LENGTH = 64
const HEX_RE = /^[0-9a-fA-F]+$/
const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.+/

/**
 * Validate third-party-tools items: each needs a tool name (identity) and a
 * download URL. Static — no target access required. The tool name is the
 * upsert identity, so a duplicate name is flagged (last one wins). A hash, when
 * given, must be hex; a length other than 64 (SHA-256) is warned rather than
 * rejected (Velociraptor does not document a single required hash algorithm). A
 * missing hash is warned — without one, a swapped download goes undetected.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one tool.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const tool = String(item.fields.tool ?? '').trim()
    const url = String(item.fields.url ?? '').trim()
    const hash = String(item.fields.hash ?? '').trim()

    if (!tool) {
      errors.push({ field: `items[${i}].tool`, message: 'Tool name is required.', code: 'EMPTY_TOOL' })
    } else {
      const key = tool.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].tool`, message: `Tool "${tool}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TOOL' })
      } else {
        seen.add(key)
      }
    }

    if (!url) {
      errors.push({ field: `items[${i}].url`, message: 'Download URL is required.', code: 'EMPTY_URL' })
    } else if (!URL_RE.test(url)) {
      errors.push({ field: `items[${i}].url`, message: `"${url}" does not look like a URL (expected scheme://...).`, code: 'INVALID_URL' })
    }

    if (!hash) {
      warnings.push({
        field: `items[${i}].hash`,
        message: `Tool "${tool || '(unnamed)'}" has no hash pinned — a compromised or swapped download would go undetected.`,
        code: 'NO_HASH',
      })
    } else if (!HEX_RE.test(hash)) {
      errors.push({ field: `items[${i}].hash`, message: `Hash "${hash}" must be a hexadecimal string.`, code: 'INVALID_HASH' })
    } else if (hash.length !== SHA256_HEX_LENGTH) {
      warnings.push({
        field: `items[${i}].hash`,
        message: `Hash for "${tool || '(unnamed)'}" is ${hash.length} hex characters, not the ${SHA256_HEX_LENGTH} expected for SHA-256 — verify the algorithm.`,
        code: 'UNEXPECTED_HASH_LENGTH',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
