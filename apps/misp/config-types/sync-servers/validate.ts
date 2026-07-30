import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { YES_NO } from './_shared'

/**
 * Validate sync-server items: a non-empty name, a non-empty http(s) URL, a
 * non-empty authkey and yes/no pull/push flags. Static — no target access
 * required. The remote URL doubles as the server identity, so a duplicate URL is
 * flagged (last one wins).
 */
const URL_RE = /^https?:\/\/.+/i

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sync server.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const url = String(item.fields.url ?? '').trim()
    const authkey = String(item.fields.authkey ?? '').trim()
    const pull = String(item.fields.pull ?? '').trim()
    const push = String(item.fields.push ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Sync server name is required.', code: 'EMPTY_NAME' })
    }

    if (!url) {
      errors.push({ field: `items[${i}].url`, message: 'Remote URL is required.', code: 'EMPTY_URL' })
    } else if (!URL_RE.test(url)) {
      errors.push({ field: `items[${i}].url`, message: `Remote URL "${url}" must be an http(s) URL.`, code: 'INVALID_URL' })
    } else if (seen.has(url)) {
      warnings.push({ field: `items[${i}].url`, message: `Remote URL ${url} is listed more than once; the last one wins.`, code: 'DUPLICATE_URL' })
    } else {
      seen.add(url)
    }

    if (!authkey) {
      errors.push({ field: `items[${i}].authkey`, message: 'Remote authkey is required.', code: 'EMPTY_AUTHKEY' })
    }

    if (!YES_NO.has(pull)) {
      errors.push({ field: `items[${i}].pull`, message: `Pull must be yes or no (got "${pull}").`, code: 'INVALID_PULL' })
    }

    if (!YES_NO.has(push)) {
      errors.push({ field: `items[${i}].push`, message: `Push must be yes or no (got "${push}").`, code: 'INVALID_PUSH' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
