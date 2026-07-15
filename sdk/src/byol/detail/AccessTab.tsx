import React from 'react'
import { EmptyState } from '../../ui'
import { isRunning } from '../status'
import type { ByolInfrastructure, ByolResource } from '../types'
import { tokens, Panel } from './shared'

const mono = 'var(--font-mono, ui-monospace, monospace)'

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '180px 1fr',
      gap: 16,
      alignItems: 'center',
      padding: '11px 0',
      borderBottom: `1px solid ${tokens.border}`,
      fontSize: 13,
    }}
  >
    <span style={{ color: tokens.muted }}>{label}</span>
    <span style={{ fontFamily: mono, fontSize: 12.5, color: tokens.text, overflowWrap: 'anywhere' }}>{value}</span>
  </div>
)

export interface AccessTabProps {
  infra: ByolInfrastructure
  resources: ByolResource[]
}

/**
 * How to reach the environment once it is running: the derived endpoints and a
 * ready-to-paste forwarder outputs.conf. Kept intentionally advisory — real
 * endpoints/credentials are surfaced by the provisioning workers via resource
 * external refs, which we prefer when present.
 */
export const AccessTab: React.FC<AccessTabProps> = ({ infra, resources }) => {
  if (!isRunning(infra.status)) {
    return (
      <EmptyState
        title="Endpoints appear once the environment is running"
        description="Deploy the environment; when the search tier is up, its Splunk Web, management and HEC endpoints show here."
      />
    )
  }

  const host = `${infra.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example.com`
  const indexers = resources
    .filter((r) => r.kind === 'indexer' && r.externalRef)
    .map((r) => `${r.externalRef}:9997`)
  const forwarderTargets = indexers.length > 0 ? indexers.join(', ') : `idx-01.${host}:9997, idx-02.${host}:9997`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Endpoints">
        <Row label="Splunk Web (search)" value={`https://${host}`} />
        <Row label="Management API" value={`https://${host}:8089`} />
        <Row label="HTTP Event Collector" value={`https://${host}:8088/services/collector`} />
      </Panel>

      <Panel title="Point a forwarder at this environment">
        <p style={{ margin: '0 0 12px', fontSize: 13, color: tokens.muted }}>
          Add this to a universal forwarder&rsquo;s <span style={{ fontFamily: mono }}>outputs.conf</span>:
        </p>
        <pre
          style={{
            margin: 0,
            background: tokens.surface2,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            padding: '13px 15px',
            fontFamily: mono,
            fontSize: 12,
            color: tokens.text,
            overflowX: 'auto',
          }}
        >
          {`[tcpout]
defaultGroup = ${infra.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}

[tcpout:${infra.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}]
server = ${forwarderTargets}
sslVerifyServerCert = true`}
        </pre>
      </Panel>
    </div>
  )
}
