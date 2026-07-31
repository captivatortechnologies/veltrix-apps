import React from 'react'
import { StatsCard } from '../../ui'
import type { ByolInfrastructure, ByolResource, ByolTopology } from '../types'
import { DEFAULT_SPLUNK_TOPOLOGY, tierValue } from '../types'
import { tokens, Panel } from './shared'

export interface OverviewTabProps {
  infra: ByolInfrastructure
  resources: ByolResource[]
  /** The app's node topology — drives the per-tier stat cards. Defaults to Splunk's. */
  topology?: ByolTopology
}

/** At-a-glance stats + a plain-language summary of what the environment comprises. */
export const OverviewTab: React.FC<OverviewTabProps> = ({ infra, resources, topology = DEFAULT_SPLUNK_TOPOLOGY }) => {
  const distributed = infra.deploymentType === 'distributed'
  const productName = topology.productName ?? 'BYOL'
  const regionCount = new Set(
    resources.map((r) => r.region).filter((r): r is string => Boolean(r) && r !== 'global'),
  ).size
  const readyCount = resources.filter((r) => r.status === 'ready').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {topology.tiers.map((t, i) => (
          <StatsCard key={t.key} label={t.label} value={tierValue(infra, t, i) ?? '—'} />
        ))}
        <StatsCard label="Regions" value={regionCount || (infra.region ? 1 : '—')} />
        <StatsCard
          label={resources.length ? 'Resources ready' : 'Resources planned'}
          value={resources.length ? `${readyCount} / ${resources.length}` : '—'}
        />
      </div>

      <Panel title="What gets deployed">
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: tokens.muted }}>
          {distributed ? (
            <>
              A distributed BYOL environment provisions a full {productName} topology: a foundation tier (network, load
              balancing, DNS, TLS, storage, secrets and your license file), a control plane, and each of the tiers above,
              plus the ingest path.
            </>
          ) : (
            <>
              A single-instance BYOL environment provisions the foundation (network, TLS, storage, secrets and your license
              file) plus one all-in-one {productName} node and an HTTP Event Collector endpoint.
            </>
          )}{' '}
          See the <strong>Resources</strong> tab for the live plan and <strong>Activity</strong> for the run log.
        </p>
      </Panel>
    </div>
  )
}
