import type { CompileIssue } from './types'

export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function issue(path: string, code: string, message: string): CompileIssue {
  return { path, code, message }
}

export function joinPath(base: string, key: string | number): string {
  return base === '' ? String(key) : `${base}.${key}`
}

export function dedupeIssues(issues: CompileIssue[]): CompileIssue[] {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const key = `${i.path}|${i.code}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}
