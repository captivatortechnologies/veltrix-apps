import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps entity watchlist constraints ------------------------------

export interface WatchlistSpec {
  itemId?: string
  /** displayName = the watchlist's identity we own (the id is server-assigned). */
  displayName: string
  description: string
  /** Risk-score multiplier applied to entities in the watchlist. */
  multiplyingFactor: number
  /** Whether the watchlist is pinned in the console. */
  pinned: boolean
}

/** A watchlist as returned by the SecOps API. `name` is `{parent}/watchlists/{id}`. */
export interface LiveWatchlist {
  name?: string
  displayName?: string
  description?: string
  multiplyingFactor?: number
  watchlistUserPreferences?: { pinned?: boolean }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

export function extractWatchlistSpecs(canvas: CanvasSnapshot): WatchlistSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      displayName: asString(f.displayName) || item.name,
      description: asString(f.description),
      multiplyingFactor: asNumber(f.multiplyingFactor, 1),
      pinned: asBool(f.pinned),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractWatchlistSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display name is required', code: 'required' })
    } else {
      const key = spec.displayName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.displayName`, message: `Duplicate watchlist "${spec.displayName}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!Number.isFinite(spec.multiplyingFactor) || spec.multiplyingFactor < 0) {
      errors.push({ field: `${prefix}.multiplyingFactor`, message: 'Multiplying factor must be a number of 0 or more', code: 'invalid_factor' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
