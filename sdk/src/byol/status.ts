// =============================================================================
// BYOL infrastructure status model — the single place the lifecycle states, their
// human labels, and their Badge variants are defined. Shared by the list and the
// detail view so a status renders identically everywhere.
//
// Lifecycle: not_started → provisioning → running, with degraded / stopped /
// failed / destroying as off-happy-path states. `active`/`error` are legacy
// synonyms emitted by the provisioning hooks (onEvent/onWebhook) and mapped here
// so old and new values render consistently.
// =============================================================================

import type { BadgeVariant } from '../ui'

export type ByolInfraStatus =
  | 'not_started'
  | 'provisioning'
  | 'running'
  | 'active'
  | 'degraded'
  | 'stopped'
  | 'failed'
  | 'error'
  | 'destroying'

const VARIANTS: Record<string, BadgeVariant> = {
  not_started: 'default',
  provisioning: 'info',
  running: 'success',
  active: 'success',
  degraded: 'warning',
  stopped: 'warning',
  failed: 'danger',
  error: 'danger',
  destroying: 'info',
}

const LABELS: Record<string, string> = {
  not_started: 'Not Started',
  provisioning: 'Provisioning',
  running: 'Running',
  active: 'Running',
  degraded: 'Degraded',
  stopped: 'Stopped',
  failed: 'Failed',
  error: 'Failed',
  destroying: 'Destroying',
}

/** Badge variant for an infrastructure status (falls back to neutral). */
export function statusVariant(status?: string): BadgeVariant {
  return (status && VARIANTS[status]) || 'default'
}

/** Human label for an infrastructure status (Title-Cases anything unknown). */
export function statusLabel(status?: string): string {
  if (!status) return 'Unknown'
  return LABELS[status] || status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Whether the environment is actively running (running/active). */
export function isRunning(status?: string): boolean {
  return status === 'running' || status === 'active'
}

/** Whether a deploy has never been requested yet. */
export function isNotStarted(status?: string): boolean {
  return !status || status === 'not_started'
}

// --- Resource statuses (per-resource rows in the Resources tab) --------------

const RESOURCE_VARIANTS: Record<string, BadgeVariant> = {
  ready: 'success',
  provisioning: 'info',
  attention: 'warning',
  failed: 'danger',
  not_started: 'default',
}

const RESOURCE_LABELS: Record<string, string> = {
  ready: 'Ready',
  provisioning: 'Provisioning',
  attention: 'Attention',
  failed: 'Failed',
  not_started: 'Not started',
}

export function resourceStatusVariant(status?: string): BadgeVariant {
  return (status && RESOURCE_VARIANTS[status]) || 'default'
}

export function resourceStatusLabel(status?: string): string {
  if (!status) return 'Not started'
  return RESOURCE_LABELS[status] || status.replace(/_/g, ' ')
}

// --- Deployment step statuses (Activity timeline) ---------------------------

const STEP_VARIANTS: Record<string, BadgeVariant> = {
  done: 'success',
  running: 'info',
  failed: 'danger',
  pending: 'default',
}

export function stepStatusVariant(status?: string): BadgeVariant {
  return (status && STEP_VARIANTS[status]) || 'default'
}
