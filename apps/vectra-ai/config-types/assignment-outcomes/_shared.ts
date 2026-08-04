// Shared helpers for the Vectra Assignment Outcomes config type (deploy + rollback +
// drift).
//
// Assignment outcomes are the custom resolution labels analysts choose when closing
// out a detection assignment (e.g. "Confirmed Phishing" mapped to
// malicious_true_positive). Full CRUD, reconciled by title. Shapes follow Vectra's
// official client (vectra_api_tools, added in API v2.2+):
//   list:   GET    /assignment_outcomes            → DRF envelope { count, results: [...] } or bare array
//   get:    GET    /assignment_outcomes/{id}
//   create: POST   /assignment_outcomes            body { title, category }
//   update: PUT    /assignment_outcomes/{id}        body { title, category }
//   delete: DELETE /assignment_outcomes/{id}
//
// FLAG (verify against a live Vectra): the list envelope shape (DRF `results` vs a
// bare array) is read defensively.

/** The three fixed resolution buckets a custom outcome must map to. */
export const OUTCOME_CATEGORIES = new Set(['benign_true_positive', 'malicious_true_positive', 'false_positive'])

export interface VectraAssignmentOutcome {
  id?: number | string
  title?: string
  category?: string
  [key: string]: unknown
}

/** Unwrap the Vectra list envelope (DRF `{ results }` or a bare array). */
export function outcomesFromList(list: unknown): VectraAssignmentOutcome[] {
  if (Array.isArray(list)) return list as VectraAssignmentOutcome[]
  if (list && typeof list === 'object' && Array.isArray((list as { results?: unknown }).results)) {
    return (list as { results: VectraAssignmentOutcome[] }).results
  }
  return []
}

/** Find a live outcome by its title (the stable identity used for upsert/drift). */
export function findOutcome(outcomes: VectraAssignmentOutcome[], title: string): VectraAssignmentOutcome | null {
  const t = title.trim()
  if (!t) return null
  return outcomes.find((o) => String(o.title ?? '').trim() === t) ?? null
}

/** Build the Vectra assignment-outcome body (create + update share the same shape). */
export function buildOutcomeBody(fields: Record<string, unknown>): { title: string; category: string } {
  return {
    title: String(fields.title ?? '').trim(),
    category: String(fields.category ?? '').trim(),
  }
}
