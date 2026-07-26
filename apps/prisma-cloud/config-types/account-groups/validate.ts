import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud account group constraints ----------------------------------

export const MAX_NAME_LENGTH = 255

export interface AccountGroupSpec {
  itemId?: string
  /** name — the identity (Prisma has no get-by-name for groups). */
  name: string
  description: string
  /** real cloud-account ids the group contains. */
  accountIds: string[]
}

/** An account group as returned by GET /cloud/group. */
export interface LiveAccountGroup {
  id?: string
  name?: string
  description?: string | null
  accountIds?: string[]
  /** true = auto-created group — read-only, never managed by this app. */
  autoCreated?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function splitIds(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractAccountGroupSpecs(canvas: CanvasSnapshot): AccountGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      accountIds: splitIds(f.accountIds),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAccountGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate account group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.accountIds.length === 0) {
      warnings.push({ field: `${prefix}.accountIds`, message: 'This account group has no cloud accounts', code: 'empty_accounts' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
