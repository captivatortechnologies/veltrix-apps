import React from 'react'
import { Badge, Tooltip } from '@veltrixsecops/app-sdk/ui'
import { ACTION_CLASS, ENFORCEMENT, EVALUATION, RUN_STATUS } from './labels'
import type { RunDto } from './api'
import type { ActionClass, Enforcement } from '../../lib/model/types'

export const RunStatusPill = ({ status }: { status: RunDto['status'] }) => {
  const { label, variant } = RUN_STATUS[status]
  return <Badge variant={variant} dot rounded>{label}</Badge>
}

export const EvaluationIndicator = ({ run }: { run: Pick<RunDto, 'status' | 'evaluation'> }) => {
  if (!run.evaluation) {
    return <span style={{ fontSize: 13, color: 'rgb(var(--color-content-tertiary-rgb, var(--color-content-tertiary)))' }}>{run.status === 'queued' || run.status === 'running' ? 'Pending' : '—'}</span>
  }
  const { label, variant, meaning } = EVALUATION[run.evaluation]
  return (
    <Tooltip content={meaning}>
      <Badge variant={variant} size="sm">{label}</Badge>
    </Tooltip>
  )
}

export const EnforcementBadge = ({ value }: { value: Enforcement }) => (
  <Tooltip content={ENFORCEMENT[value].meaning}>
    <Badge variant={ENFORCEMENT[value].variant} size="sm">{ENFORCEMENT[value].label}</Badge>
  </Tooltip>
)

export const ActionClassBadge = ({ value }: { value: ActionClass }) => (
  <Tooltip content={ACTION_CLASS[value].meaning}>
    <Badge variant={ACTION_CLASS[value].variant} size="sm">{ACTION_CLASS[value].label}</Badge>
  </Tooltip>
)
