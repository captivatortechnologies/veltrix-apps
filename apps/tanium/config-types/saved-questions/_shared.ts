// Shared shapes + body builders for the Tanium Saved Questions config type.
//
// A saved question (GET/POST /api/v2/saved_questions, .../by-name/{name},
// .../{id}) pairs a `name` with a `question`. Tanium's public integrations create
// one by referencing a PRE-PARSED question by id — `{ name, question: { id } }`
// (Cortex XSOAR Tanium_v2 `tn-create-saved-question` takes question-id + name;
// Splunk SOAR taniumrest reads saved_questions by name). The question object's
// text field is `question_text` (seen on /api/v2/parse_question responses in the
// Splunk taniumrest connector).
//
// VERIFY AGAINST A LIVE TANIUM (FLAGGED): passing an INLINE `question.question_text`
// to POST /api/v2/saved_questions and letting the server parse it is a REST v2
// convenience that the public integrations do NOT exercise — they pre-parse via
// POST /api/v2/parse_question then create the question (POST /api/v2/questions)
// and reference it by id. Some builds require that pre-parse step; the optional
// `questionId` field takes the verified by-id path when the operator has one.

import type { NamedEntity } from '../../lib/taniumRestEntity'

/** Tanium's REST v2 collection name for this object. */
export const SAVED_QUESTIONS_RESOURCE = 'saved_questions'

/** The `question` sub-object carried by a saved question. */
export interface TaniumQuestionRef {
  id?: number | string
  question_text?: string
  /** Some builds surface the text as `query_text`; read both when comparing. */
  query_text?: string
}

/** One saved question as returned by /api/v2/saved_questions (usually `{ data: {...} }`). */
export interface TaniumSavedQuestion extends NamedEntity {
  question?: TaniumQuestionRef
}

/** The body POST /api/v2/saved_questions accepts — a name plus a question reference. */
export interface TaniumSavedQuestionBody {
  name: string
  question: { id: number } | { question_text: string }
}

/** The question text carried by a saved question, tolerating either field name. */
export function savedQuestionText(sq: TaniumSavedQuestion | null | undefined): string {
  return String(sq?.question?.question_text ?? sq?.question?.query_text ?? '').trim()
}

/** Parse the optional numeric `questionId`. Blank → none; non-integer/≤0 → error. */
export function parseQuestionId(raw: unknown): { value?: number; error?: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { value: undefined }
  if (!/^\d+$/.test(s)) return { error: 'Question ID must be a positive whole number.' }
  const n = Number(s)
  if (!Number.isInteger(n) || n <= 0) return { error: 'Question ID must be a positive whole number.' }
  return { value: n }
}

/**
 * Build the saved-question body from canvas fields. A `questionId` takes the
 * verified by-id path (`{ question: { id } }`); otherwise the question text is sent
 * inline (`{ question: { question_text } }`) for the server to parse.
 */
export function buildSavedQuestionBody(fields: Record<string, unknown>): TaniumSavedQuestionBody {
  const name = String(fields.name ?? '').trim()
  const parsedId = parseQuestionId(fields.questionId)
  if (parsedId.value !== undefined) return { name, question: { id: parsedId.value } }
  return { name, question: { question_text: String(fields.questionText ?? '').trim() } }
}

/**
 * Rebuild a POST body from a captured prior saved question for rollback. Prefers
 * the prior question's id (the verified path); falls back to its text.
 */
export function restoreSavedQuestionBody(prior: TaniumSavedQuestion): TaniumSavedQuestionBody {
  const name = String(prior.name ?? '').trim()
  const id = prior.question?.id
  if (id != null && /^\d+$/.test(String(id))) return { name, question: { id: Number(id) } }
  return { name, question: { question_text: savedQuestionText(prior) } }
}
