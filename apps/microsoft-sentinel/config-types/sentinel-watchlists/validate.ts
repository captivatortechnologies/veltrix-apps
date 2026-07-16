import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** Watchlist aliases become the ARM resource name — keep them URL-safe. */
export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** One watchlist authored on the canvas. */
export interface WatchlistSpec {
  sectionName: string
  /** The watchlist alias — used directly as the ARM watchlistAlias (the identity). */
  alias: string
  displayName: string
  provider: string
  itemsSearchKey: string
  itemsCsv: string
  numberOfLinesToSkip: number
}

/** The reconciliation key is the alias (lower-cased for matching). */
export function watchlistKey(alias: string): string {
  return alias.trim().toLowerCase()
}

/** Parse a number field. NON-UNION result: value is null when unparseable. */
export function readNumber(value: unknown): { value: number | null; error: string | null } {
  if (typeof value === 'number' && Number.isFinite(value)) return { value, error: null }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return { value: n, error: null }
    return { value: null, error: `"${value}" is not a number` }
  }
  return { value: null, error: null }
}

/** Each canvas item is one watchlist. */
export function extractWatchlistSpecs(canvas: CanvasSnapshot): WatchlistSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const skip = readNumber(fields.number_of_lines_to_skip)
    return {
      sectionName: section.name,
      alias: typeof fields.alias === 'string' ? fields.alias.trim() : '',
      displayName: typeof fields.display_name === 'string' ? fields.display_name.trim() : '',
      provider: typeof fields.provider === 'string' && fields.provider.trim() ? fields.provider.trim() : 'Custom',
      itemsSearchKey: typeof fields.items_search_key === 'string' ? fields.items_search_key.trim() : '',
      itemsCsv: typeof fields.items_csv === 'string' ? fields.items_csv : '',
      numberOfLinesToSkip: skip.value ?? 0,
    }
  })
}

/** The header row of the CSV (the first line after the skipped lines), split into trimmed columns. */
export function csvHeaderColumns(itemsCsv: string, numberOfLinesToSkip: number): string[] {
  const lines = itemsCsv.split(/\r?\n/)
  const header = lines[numberOfLinesToSkip] ?? ''
  return header.split(',').map((c) => c.trim()).filter((c) => c.length > 0)
}

/**
 * Validate watchlists. Each needs a URL-safe unique alias, a display name and a
 * search key. When inline CSV content is supplied, the search key must be one of
 * the header columns (Sentinel keys items on that column).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no watchlists', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractWatchlistSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.alias) {
      errors.push({ field: `${prefix}.alias`, message: 'Watchlist alias is required', code: 'required' })
    } else {
      if (!ALIAS_RE.test(spec.alias)) {
        errors.push({
          field: `${prefix}.alias`,
          message: `Alias "${spec.alias}" must start with a letter/number and contain only letters, numbers, hyphens or underscores`,
          code: 'invalid_alias',
        })
      }
      const key = watchlistKey(spec.alias)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.alias`, message: `Duplicate watchlist alias "${spec.alias}"`, code: 'duplicate_alias' })
      }
      seen.add(key)
    }

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.display_name`, message: 'Display name is required', code: 'required' })
    }

    if (!spec.itemsSearchKey) {
      errors.push({ field: `${prefix}.items_search_key`, message: 'Items search key is required', code: 'required' })
    }

    if (spec.numberOfLinesToSkip < 0 || !Number.isInteger(spec.numberOfLinesToSkip)) {
      errors.push({ field: `${prefix}.number_of_lines_to_skip`, message: 'Number of lines to skip must be a non-negative integer', code: 'invalid_skip' })
    }

    if (spec.itemsCsv.trim() && spec.itemsSearchKey) {
      const cols = csvHeaderColumns(spec.itemsCsv, spec.numberOfLinesToSkip)
      if (cols.length > 0 && !cols.includes(spec.itemsSearchKey)) {
        errors.push({
          field: `${prefix}.items_search_key`,
          message: `Search key "${spec.itemsSearchKey}" is not a column in the CSV header (${cols.join(', ')})`,
          code: 'search_key_missing',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
