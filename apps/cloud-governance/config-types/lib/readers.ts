import type { CanvasItemSnapshot, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { CompileIssue } from '../../lib/model/types'
import { isRecord } from '../../lib/model/issues'

export function itemsOf(canvas: CanvasSnapshot): CanvasItemSnapshot[] {
  return canvas.items ?? canvas.sections ?? []
}

export function readString(fields: Record<string, unknown>, key: string): string {
  const value = fields[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function readOptionalString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = readString(fields, key)
  return value === '' ? undefined : value
}

/** Blank -> undefined; numeric text -> number; anything else is kept raw so the model validator reports it. */
export function readOptionalNumber(fields: Record<string, unknown>, key: string): unknown {
  const value = fields[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed !== '' && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed
  }
  return value
}

export function readBoolean(fields: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = fields[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** tags / multiselect values arrive as arrays; comma or newline separated text is tolerated. */
export function readList(fields: Record<string, unknown>, key: string): string[] {
  const value = fields[key]
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : []
  return raw.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter((entry) => entry !== '')
}

/** keyvalue fields arrive as `[{key,value}]`; a plain object is accepted too. */
export function readRecord(fields: Record<string, unknown>, key: string): Record<string, string> {
  const value = fields[key]
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isRecord(entry) && typeof entry.key === 'string' && entry.key.trim() !== '') {
        out[entry.key.trim()] = entry.value == null ? '' : String(entry.value)
      }
    }
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v == null ? '' : String(v)
  }
  return out
}

export interface JsonArrayRead {
  value: unknown[]
  issue: CompileIssue | null
}

export function readJsonArray(fields: Record<string, unknown>, key: string): JsonArrayRead {
  const raw = fields[key]
  if (Array.isArray(raw)) return { value: raw, issue: null }
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { value: [], issue: null }
  if (typeof raw !== 'string') {
    return { value: [], issue: { path: key, code: 'JSON_INVALID', message: `${key} must be a JSON array` } }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return { value: parsed, issue: null }
    return { value: [], issue: { path: key, code: 'JSON_NOT_ARRAY', message: `${key} must be a JSON array` } }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'parse error'
    return { value: [], issue: { path: key, code: 'JSON_INVALID', message: `${key} is not valid JSON: ${detail}` } }
  }
}
