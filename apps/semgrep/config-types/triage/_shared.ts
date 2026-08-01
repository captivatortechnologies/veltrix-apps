// Shared helpers for the Semgrep Findings Triage config type
// (validate + deploy + rollback + drift).
//
// IMPORTANT / FLAGGED — read this before treating triage as "config":
// Semgrep has NO triage-rule resource. The only write path is an IMPERATIVE bulk
// action: POST /deployments/{slug}/triage, which sets the triage state of the
// findings that match a selection RIGHT NOW. This config type models a triage
// RULE locally (a named selection + desired state); deploy RE-APPLIES it to
// whatever findings currently match. There is nothing on the server to reconcile,
// findings are a moving target (new scans surface new findings), so:
//   - drift is best-effort — it re-queries GET /findings for findings that match
//     the selection but are NOT yet in the target state, and reports the count;
//   - rollback is best-effort — it re-triages the EXACT finding ids this deploy
//     changed back to `reopened` (recorded in rollbackData). It cannot restore a
//     finding's prior per-finding triage reason/note.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canvasItems, strList } from '../../lib/canvas'

export const ISSUE_TYPES = ['sast', 'sca', 'secrets'] as const
export const TARGET_STATES = ['ignored', 'reviewing', 'fixing', 'reopened', 'provisionally_ignored'] as const
/** `new_triage_reason` is only valid when the target state is `ignored`. */
export const TRIAGE_REASONS = ['acceptable_risk', 'false_positive', 'no_time', 'duplicate'] as const
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
/** Source statuses a triage rule may move findings FROM (findings GET status enum). */
export const FROM_STATUSES = ['open', 'reviewing', 'fixing'] as const
/** The Semgrep API cap on a triage note. */
export const MAX_NOTE_LENGTH = 3000

/** One triage rule authored on the canvas. */
export interface TriageSpec {
  /** Local, author-supplied name for the rule. The identity (NOT a server object). */
  ruleName: string
  issueType: string
  /** Desired triage state (new_triage_state). */
  targetState: string
  /** Optional triage reason (new_triage_reason) — only valid with targetState `ignored`. */
  triageReason: string
  /** Optional note attached to the triaged findings (new_note). */
  note: string
  /** Selection filter: repositories (project names). */
  repos: string[]
  /** Selection filter: rule names (applies to sast findings). */
  rules: string[]
  /** Selection filter: severities. */
  severities: string[]
  /** Which current status the findings are moved FROM. */
  fromStatus: string
}

function pickString(value: unknown, allowed: readonly string[], fallback: string): string {
  const v = String(value ?? '').trim()
  return (allowed as readonly string[]).includes(v) ? v : fallback
}

/** Build a TriageSpec from one canvas item's fields. */
export function triageSpecFromFields(fields: Record<string, unknown>): TriageSpec {
  return {
    ruleName: String(fields.ruleName ?? '').trim(),
    issueType: String(fields.issueType ?? '').trim(),
    targetState: String(fields.targetState ?? '').trim(),
    triageReason: String(fields.triageReason ?? '').trim(),
    note: String(fields.note ?? '').trim(),
    repos: strList(fields.repos),
    rules: strList(fields.rules),
    severities: strList(fields.severities).map((s) => s.toLowerCase()),
    fromStatus: pickString(fields.fromStatus, FROM_STATUSES, 'open'),
  }
}

/** Every triage rule authored on the canvas. */
export function extractTriageSpecs(canvas: CanvasSnapshot): TriageSpec[] {
  return canvasItems(canvas).map((item) => triageSpecFromFields(item.fields ?? {}))
}

/** True when the rule narrows the selection (never triage a whole deployment). */
export function hasNarrowingFilter(spec: TriageSpec): boolean {
  return spec.repos.length > 0 || spec.rules.length > 0 || spec.severities.length > 0
}

/** The POST /triage body that applies a rule to the findings matching it now. */
export function buildTriageBody(spec: TriageSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    issue_type: spec.issueType,
    new_triage_state: spec.targetState,
    status: spec.fromStatus,
  }
  if (spec.triageReason) body.new_triage_reason = spec.triageReason
  if (spec.note) body.new_note = spec.note
  if (spec.repos.length > 0) body.repos = spec.repos
  if (spec.rules.length > 0) body.rules = spec.rules
  if (spec.severities.length > 0) body.severities = spec.severities
  return body
}

/** The GET /findings query for drift: findings still matching the rule's source selection. */
export function buildFindingsQuery(spec: TriageSpec): Record<string, string | string[] | number | undefined> {
  const query: Record<string, string | string[] | number | undefined> = {
    issue_type: spec.issueType,
    status: spec.fromStatus,
    page_size: 100,
  }
  if (spec.repos.length > 0) query.repos = spec.repos
  if (spec.rules.length > 0) query.rules = spec.rules
  if (spec.severities.length > 0) query.severities = spec.severities
  return query
}
