import React from 'react'
import { EmptyState } from '../../ui'
import { isRunning } from '../status'
import type { ByolInfrastructure, ByolResource } from '../types'
import { tokens, Panel } from './shared'

const mono = 'var(--font-mono, ui-monospace, monospace)'

/**
 * Resolve a usable network host from a resource's external ref. The provisioner
 * reports the managed DNS FQDN (`foundation/dns`) and the load balancer's DNS
 * name (`ingest/hec` → the ALB `dns_name`) as real hostnames; other refs are
 * ARNs, ids, or — before real provisioning has reported anything — placeholders.
 * Only a value that is genuinely a hostname or URL is returned; everything else
 * yields null so the UI never presents a non-reachable string as an endpoint.
 */
function asHost(ref: string | null | undefined): string | null {
  if (!ref) return null
  const v = ref.trim()
  if (/^https?:\/\//i.test(v)) {
    try {
      return new URL(v).host
    } catch {
      return null
    }
  }
  // A DNS hostname: dot-separated labels, alphanumerics/hyphens, TLD ≥ 2 chars.
  const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
  return HOSTNAME.test(v) ? v : null
}

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
 * How to reach the environment once it is running. Every endpoint is derived
 * from the REAL external references the provisioning worker writes onto the
 * resource rows (the managed DNS name, the load balancer, the indexer peers) —
 * nothing is fabricated. Until the worker has reported a reachable endpoint, the
 * tab says so plainly rather than inventing a placeholder host.
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

  const refOf = (planKey: string): string | null =>
    resources.find((r) => r.planKey === planKey)?.externalRef ?? null

  // Managed DNS FQDN is the friendly host for Splunk Web + management; the ALB
  // DNS name (reported on ingest/hec) is where HEC lives and a fallback host.
  const dnsHost = asHost(refOf('foundation/dns'))
  const albHost = asHost(refOf('ingest/hec'))
  const webHost = dnsHost ?? albHost
  const hecHost = albHost ?? dnsHost

  // Forwarder targets: only indexer peers that have reported a real address.
  const indexerTargets = resources
    .filter((r) => r.kind === 'indexer')
    .map((r) => asHost(r.externalRef))
    .filter((h): h is string => Boolean(h))
    .map((h) => `${h}:9997`)

  const endpoints: Array<{ label: string; value: string }> = []
  if (webHost) {
    endpoints.push({ label: 'Splunk Web (search)', value: `https://${webHost}` })
    endpoints.push({ label: 'Management API', value: `https://${webHost}:8089` })
  }
  if (hecHost) {
    endpoints.push({ label: 'HTTP Event Collector', value: `https://${hecHost}:8088/services/collector` })
  }

  // Running, but the worker hasn't published a reachable endpoint yet (e.g. the
  // load balancer / DNS name is still settling). Be honest — no invented host.
  if (endpoints.length === 0) {
    return (
      <Panel title="Endpoints">
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: tokens.muted }}>
          The environment is running, but the provisioner has not reported a reachable endpoint yet.
          Splunk Web, the management API and the HTTP Event Collector URL appear here as soon as the
          load balancer and DNS name are published. Check the <strong>Resources</strong> tab for each
          component&rsquo;s external reference.
        </p>
      </Panel>
    )
  }

  const tcpoutGroup = infra.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'veltrix_splunk'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Endpoints">
        {endpoints.map((e) => (
          <Row key={e.label} label={e.label} value={e.value} />
        ))}
      </Panel>

      <Panel title="Point a forwarder at this environment">
        {indexerTargets.length > 0 ? (
          <>
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
defaultGroup = ${tcpoutGroup}

[tcpout:${tcpoutGroup}]
server = ${indexerTargets.join(', ')}
sslVerifyServerCert = true`}
            </pre>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>
            Forwarder targets appear here once the indexer peers report their addresses.
          </p>
        )}
      </Panel>
    </div>
  )
}
