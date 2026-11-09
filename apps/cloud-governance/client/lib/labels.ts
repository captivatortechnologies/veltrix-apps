import type { BadgeVariant } from '@veltrixsecops/app-sdk/ui'
import type { ActionClass, Enforcement } from '../../lib/model/types'
import type { RunDto } from './api'

export const ACTION_CLASS: Record<ActionClass, { label: string; variant: BadgeVariant; meaning: string }> = {
  none: { label: 'Read only', variant: 'default', meaning: 'Only reports findings. Never changes a resource.' },
  reversible: { label: 'Reversible', variant: 'info', meaning: 'Changes can be undone, such as tagging or stopping an instance.' },
  'snapshot-delete': { label: 'Snapshot then delete', variant: 'warning', meaning: 'Takes a snapshot before deleting, so the resource can be restored.' },
  irreversible: { label: 'Irreversible', variant: 'danger', meaning: 'Permanently deletes or alters resources. This cannot be undone.' },
}

export const ENFORCEMENT: Record<Enforcement, { label: string; variant: BadgeVariant; meaning: string }> = {
  observe: { label: 'Observe', variant: 'default', meaning: 'Preview only. Enforcement is never requested.' },
  notify: { label: 'Notify', variant: 'info', meaning: 'Findings are reported to owners. Nothing is changed.' },
  ask: { label: 'Ask', variant: 'warning', meaning: 'Changes are applied only after someone approves a preview.' },
  auto: { label: 'Auto', variant: 'danger', meaning: 'Changes are applied automatically on each run.' },
}

export const RUN_STATUS: Record<RunDto['status'], { label: string; variant: BadgeVariant }> = {
  queued: { label: 'Queued', variant: 'default' },
  running: { label: 'Running', variant: 'info' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'warning' },
}

export const EVALUATION: Record<NonNullable<RunDto['evaluation']>, { label: string; variant: BadgeVariant; meaning: string }> = {
  evaluated: { label: 'Evaluated', variant: 'success', meaning: 'The policy was evaluated against the account.' },
  failed: { label: 'Failed to evaluate', variant: 'danger', meaning: 'The policy could not be evaluated, so no result should be trusted.' },
  'not-visible': { label: 'Not visible', variant: 'warning', meaning: 'The resource type is not visible to the assumed role, so it was not checked.' },
}

export const OUTCOME_VARIANT: Record<string, BadgeVariant> = { applied: 'success', skipped: 'default', failed: 'danger' }

export const isActive = (run: Pick<RunDto, 'status'>) => run.status === 'queued' || run.status === 'running'

export const canEnforce = (enforcement: Enforcement) => enforcement === 'ask' || enforcement === 'auto'

export const formatTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
