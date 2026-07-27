import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/falcon'

// --- Next-Gen SIEM Lookup File API constraints -------------------------------
//
// A lookup file is a CSV enrichment table looked up at query time. The verified
// JSON (bulk) endpoint carries the CSV inline as { filename, content } under a
// `search_domain`. This app maps the canvas "repository" field to search_domain.
// "Key columns" are a query-time concept (there is no key-column field on the
// API), so they are validated against the CSV header but not sent to Falcon.

/** search_domain values CrowdStrike documents for lookup files. */
export const LOOKUP_SEARCH_DOMAINS = [
  'all',
  'falcon',
  'third-party',
  'dashboards',
  'parsers-repository',
] as const

/** Default search_domain when the canvas leaves repository blank. */
export const DEFAULT_SEARCH_DOMAIN = 'all'

export const MAX_FILENAME_LENGTH = 255

// A filename with no path separators or whitespace; the CSV content lives in a
// separate field, so the name is just an identifier ending in .csv.
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface LookupSpec {
  sectionName: string
  filename: string
  /** Maps to the API `search_domain` — the NG-SIEM view/repository. */
  repository: string
  /** CSV enrichment table content. */
  content: string
  /** Advisory key columns (validated against the header; not sent to Falcon). */
  keyColumns: string[]
}

/** Shape of a lookup file returned by the NG-SIEM lookup-file endpoints. */
export interface LiveLookupFile {
  filename?: string
  content?: string
  search_domain?: string
  /** Last modifier — read best-effort for drift attribution (field names unverified for NG-SIEM). */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
  [key: string]: unknown
}

/** Each canvas section describes one Falcon Next-Gen SIEM lookup file. */
export function extractLookupSpecs(canvas: CanvasSnapshot): LookupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const repository =
      typeof fields.repository === 'string' && fields.repository.trim()
        ? fields.repository.trim()
        : DEFAULT_SEARCH_DOMAIN

    return {
      sectionName: section.name,
      filename: typeof fields.filename === 'string' ? fields.filename.trim() : '',
      repository,
      // Preserve CSV content verbatim (row/column layout is significant).
      content: typeof fields.content === 'string' ? fields.content : '',
      keyColumns: splitList(fields.keyColumns),
    }
  })
}

/**
 * Parse the header row of a CSV document into trimmed column names. Simple
 * comma split — quoted/escaped commas are not handled, matching how enrichment
 * table headers are authored. Returns [] for empty content.
 */
export function parseCsvHeader(content: string): string[] {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return []
  return firstLine.split(',').map((col) => col.trim())
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Next-Gen SIEM lookup file configurations: a required unique
 * filename, non-empty CSV content, and (when declared) key columns that exist
 * in the CSV header.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({
      field: 'sections',
      message: 'Canvas has no configuration sections',
      code: 'empty_canvas',
    })
    return { valid: false, errors, warnings }
  }

  const specs = extractLookupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // filename — required, bounded, safe characters, .csv, unique per canvas
    if (!spec.filename) {
      errors.push({ field: `${prefix}.filename`, message: 'Filename is required', code: 'required' })
    } else {
      if (spec.filename.length > MAX_FILENAME_LENGTH) {
        errors.push({
          field: `${prefix}.filename`,
          message: `Filename must be ${MAX_FILENAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const base = spec.filename.replace(/\.csv$/i, '')
      if (!FILENAME_RE.test(base)) {
        errors.push({
          field: `${prefix}.filename`,
          message:
            'Filename may contain only letters, numbers, dot, underscore and hyphen (no spaces or path separators)',
          code: 'invalid_filename',
        })
      }
      if (!/\.csv$/i.test(spec.filename)) {
        errors.push({
          field: `${prefix}.filename`,
          message: 'Lookup file name must end in .csv',
          code: 'not_csv',
        })
      }
      const key = spec.filename.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.filename`,
          message: `Duplicate filename "${spec.filename}" — each lookup file may only be declared once per canvas`,
          code: 'duplicate_filename',
        })
      }
      seenNames.add(key)
    }

    // content — required, non-empty CSV
    const header = parseCsvHeader(spec.content)
    if (!spec.content || !spec.content.trim()) {
      errors.push({
        field: `${prefix}.content`,
        message: 'CSV content is required',
        code: 'empty_content',
      })
    } else if (header.length === 0) {
      errors.push({
        field: `${prefix}.content`,
        message: 'CSV content has no header row',
        code: 'empty_content',
      })
    }

    // key columns — advisory, but must exist in the header when declared
    if (spec.keyColumns.length === 0) {
      warnings.push({
        field: `${prefix}.keyColumns`,
        message: 'No key columns declared — enrichment lookups usually match on at least one column',
        code: 'no_key_columns',
      })
    } else if (header.length > 0) {
      const headerSet = new Set(header.map((c) => c.toLowerCase()))
      for (const column of spec.keyColumns) {
        if (!headerSet.has(column.toLowerCase())) {
          errors.push({
            field: `${prefix}.keyColumns`,
            message: `Key column "${column}" is not present in the CSV header (${header.join(', ')})`,
            code: 'key_column_missing',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
