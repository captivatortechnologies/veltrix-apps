import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORKS, normalizeNetwork, parseRecipients } from './_shared'

/**
 * Validate activation items: a non-empty network list name (≤100 chars), a known
 * environment (STAGING/PRODUCTION), and well-formed notification recipient
 * emails. Static — no target access. The (name + environment) pair is the real
 * identity, so the SAME list activated twice on the SAME environment is flagged
 * (last one wins). The list's existence is checked at deploy time (it needs the
 * live API), not here.
 */

// Pragmatic email shape — a single @, non-empty local part and a dotted domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one activation.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.networkListName ?? '').trim()
    const rawNetwork = String(item.fields.network ?? '').trim().toUpperCase()
    const network = normalizeNetwork(item.fields.network)
    const recipients = parseRecipients(item.fields.notificationRecipients)

    if (!name) {
      errors.push({ field: `items[${i}].networkListName`, message: 'Network list name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 100) {
      errors.push({ field: `items[${i}].networkListName`, message: 'Network list name must be 100 characters or fewer.', code: 'NAME_TOO_LONG' })
    }

    if (!NETWORKS.has(rawNetwork)) {
      errors.push({ field: `items[${i}].network`, message: `Environment must be STAGING or PRODUCTION (got "${rawNetwork || '(empty)'}").`, code: 'INVALID_NETWORK' })
    }

    if (name) {
      const key = `${name.toLowerCase()}::${network}`
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].networkListName`, message: `"${name}" is activated on ${network} more than once; the last one wins.`, code: 'DUPLICATE_TARGET' })
      } else {
        seen.add(key)
      }
    }

    recipients.forEach((email, j) => {
      if (!EMAIL_RE.test(email)) {
        errors.push({ field: `items[${i}].notificationRecipients[${j}]`, message: `Notification recipient "${email}" is not a valid email address.`, code: 'INVALID_EMAIL' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
