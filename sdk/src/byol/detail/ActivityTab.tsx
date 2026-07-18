import React from 'react'
import { EmptyState, Badge } from '../../ui'
import { formatDateTime } from '../api'
import { stepStatusVariant } from '../status'
import type { ByolDeployment, ByolDeploymentStep } from '../types'
import { tokens } from './shared'

const NODE_COLOR: Record<string, string> = {
  done: tokens.success,
  running: tokens.info,
  failed: tokens.danger,
  pending: tokens.borderStrong,
}

const StepNode: React.FC<{ step: ByolDeploymentStep; last: boolean }> = ({ step, last }) => (
  <div style={{ position: 'relative', paddingBottom: last ? 0 : 20 }}>
    <span
      style={{
        position: 'absolute',
        left: -24,
        top: 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: NODE_COLOR[step.status] ?? NODE_COLOR.pending,
        border: `3px solid ${tokens.surface}`,
        boxShadow: `0 0 0 1px ${tokens.border}`,
      }}
    />
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 600, fontSize: 14, color: tokens.text }}>{step.title}</span>
      <Badge variant={stepStatusVariant(step.status)} size="sm">
        {step.status}
      </Badge>
      <span style={{ fontSize: 12, color: tokens.faint }}>
        {step.completedAt ? formatDateTime(step.completedAt) : step.startedAt ? formatDateTime(step.startedAt) : ''}
      </span>
    </div>
    {step.detail ? <div style={{ fontSize: 13, color: tokens.muted, marginTop: 3 }}>{step.detail}</div> : null}
    {step.logs ? (
      <pre
        style={{
          marginTop: 8,
          background: tokens.surface2,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          padding: '9px 12px',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 11.5,
          color: tokens.muted,
          whiteSpace: 'pre-wrap',
          overflowX: 'auto',
        }}
      >
        {step.logs}
      </pre>
    ) : null}
  </div>
)

const RunTimeline: React.FC<{ run: ByolDeployment }> = ({ run }) => (
  <div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: tokens.text, textTransform: 'capitalize' }}>
        {run.action} run
      </h3>
      <Badge variant={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'danger' : 'info'} size="sm">
        {run.status}
      </Badge>
      <span style={{ fontSize: 12, color: tokens.faint }}>started {formatDateTime(run.startedAt)}</span>
    </div>
    <div style={{ position: 'relative', paddingLeft: 26 }}>
      <span style={{ position: 'absolute', left: 8, top: 4, bottom: 4, width: 2, background: tokens.border }} />
      {run.steps.map((s, i) => (
        <StepNode key={s.id || s.key} step={s} last={i === run.steps.length - 1} />
      ))}
    </div>
  </div>
)

export interface ActivityTabProps {
  deployments: ByolDeployment[]
}

/** The deployment run log: the latest run as a live timeline, older runs below. */
export const ActivityTab: React.FC<ActivityTabProps> = ({ deployments }) => {
  if (deployments.length === 0) {
    return (
      <EmptyState
        title="No deployment activity yet"
        description="When you deploy this environment, each provisioning step will stream here."
      />
    )
  }
  const [latest, ...previous] = deployments
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <RunTimeline run={latest} />
      {previous.length > 0 ? (
        <div>
          <h4 style={{ margin: '0 0 10px', fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase', color: tokens.faint }}>
            Earlier runs
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {previous.map((run) => (
              <div
                key={run.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '10px 14px',
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 8,
                  background: tokens.surface,
                  fontSize: 13,
                }}
              >
                <span style={{ textTransform: 'capitalize', color: tokens.text }}>{run.action}</span>
                <span style={{ color: tokens.faint }}>{formatDateTime(run.startedAt)}</span>
                <Badge variant={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'danger' : 'info'} size="sm">
                  {run.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
