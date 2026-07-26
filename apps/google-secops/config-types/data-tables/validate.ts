import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps data table constraints ------------------------------------

/** dataTableId + column names: start with a letter, letters/digits/underscore. */
const ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/
export const COLUMN_TYPES = ['STRING', 'REGEX', 'CIDR', 'NUMBER'] as const

export interface Column {
  name: string
  type: string
}

export interface DataTableSpec {
  itemId?: string
  /** name = dataTableId — the immutable identity. */
  name: string
  description: string
  columns: Column[]
  /** rows, each a positional list of string values matching the columns. */
  rows: string[][]
}

/** A data table as returned by the SecOps API. */
export interface LiveDataTable {
  name?: string
  description?: string
  columnInfo?: Array<{ columnIndex?: number; originalColumn?: string; columnType?: string }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse "name" or "name:TYPE" comma-separated columns. */
export function parseColumns(v: unknown): Column[] {
  return asString(v)
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c) => {
      const colon = c.indexOf(':')
      if (colon < 0) return { name: c, type: 'STRING' }
      return { name: c.slice(0, colon).trim(), type: c.slice(colon + 1).trim().toUpperCase() }
    })
}

/** Parse rows textarea — one row per line, comma-separated values. */
export function parseRows(v: unknown): string[][] {
  return asString(v)
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(',').map((cell) => cell.trim()))
}

export function extractDataTableSpecs(canvas: CanvasSnapshot): DataTableSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      columns: parseColumns(f.columns),
      rows: parseRows(f.rows),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDataTableSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (!ID_RE.test(spec.name)) {
        errors.push({ field: `${prefix}.name`, message: 'Name must start with a letter and contain only letters, digits and underscores', code: 'invalid_name' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate data table "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })
    }

    if (spec.columns.length === 0) {
      errors.push({ field: `${prefix}.columns`, message: 'At least one column is required', code: 'missing_columns' })
    }
    spec.columns.forEach((c, ci) => {
      if (!ID_RE.test(c.name)) {
        errors.push({ field: `${prefix}.columns[${ci}]`, message: `Column "${c.name}" must start with a letter and contain only letters, digits and underscores`, code: 'invalid_column' })
      }
      if (!(COLUMN_TYPES as readonly string[]).includes(c.type)) {
        errors.push({ field: `${prefix}.columns[${ci}]`, message: `Column "${c.name}" type must be one of: ${COLUMN_TYPES.join(', ')}`, code: 'invalid_column_type' })
      }
    })

    spec.rows.forEach((row, ri) => {
      if (spec.columns.length && row.length !== spec.columns.length) {
        errors.push({ field: `${prefix}.rows[${ri}]`, message: `Row has ${row.length} value(s) but the table has ${spec.columns.length} column(s)`, code: 'row_arity' })
      }
    })

    if (spec.rows.length === 0) {
      warnings.push({ field: `${prefix}.rows`, message: 'This data table has no rows', code: 'empty_table' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
