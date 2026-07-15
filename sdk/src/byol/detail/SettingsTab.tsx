import React from 'react'
import { Button } from '../../ui'
import { SELF_HOSTED_LABEL, type ByolInfrastructure } from '../types'
import { isNotStarted } from '../status'
import { tokens, Panel } from './shared'

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '200px 1fr',
      gap: 16,
      padding: '11px 0',
      borderBottom: `1px solid ${tokens.border}`,
      fontSize: 13,
    }}
  >
    <span style={{ color: tokens.muted }}>{label}</span>
    <span style={{ color: tokens.text, fontWeight: 600 }}>{value}</span>
  </div>
)

export interface SettingsTabProps {
  infra: ByolInfrastructure
  busy: boolean
  onEdit: () => void
  onDestroy: () => void
  onDelete: () => void
}

/** Topology summary + the danger zone (destroy / delete). */
export const SettingsTab: React.FC<SettingsTabProps> = ({ infra, busy, onEdit, onDestroy, onDelete }) => {
  const provider = infra.hosting_type || (infra.cloudProviderId ? 'Cloud' : SELF_HOSTED_LABEL)
  const neverDeployed = isNotStarted(infra.status)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel
        title="Topology"
        actions={
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
            Edit
          </Button>
        }
      >
        <Row label="Name" value={infra.name} />
        <Row label="Deployment type" value={infra.deploymentType ?? '—'} />
        <Row label="Indexers / Search heads" value={`${infra.indexerCount ?? '—'} / ${infra.searchHeadCount ?? '—'}`} />
        <Row label="Provider" value={provider} />
        <Row label="Region" value={infra.region || '—'} />
        <Row label="Environment" value={infra.environmentType || '—'} />
      </Panel>

      <div style={{ border: `1px solid ${tokens.danger}`, borderRadius: 12, padding: '16px 18px' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14, color: tokens.danger }}>Danger zone</h3>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: tokens.muted }}>
          {neverDeployed
            ? 'This environment has not been deployed. Deleting removes the record and its plan.'
            : 'Destroy tears down every resource in the plan — instances, storage, network. This cannot be undone.'}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!neverDeployed ? (
            <Button variant="ghost" size="sm" onClick={onDestroy} disabled={busy}>
              Destroy infrastructure
            </Button>
          ) : null}
          <Button variant="danger" size="sm" onClick={onDelete} disabled={busy}>
            Delete record
          </Button>
        </div>
      </div>
    </div>
  )
}
