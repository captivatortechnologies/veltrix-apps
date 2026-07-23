import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  authFetch,
  testConnection,
  type CredentialSummary,
  type ConnectivityProviderRef,
  type InventoryItem,
  type TestConnectionResult,
} from '@veltrixsecops/app-sdk/client'
import { Modal, Badge, Button, Spinner, Alert, useToast } from '@veltrixsecops/app-sdk/ui'

const APP_ID = 'splunk-enterprise'

// The one ZTNA provider type the platform operates itself (a managed Tailscale
// tailnet) — only this type gets the "Connect via Tailscale" enrollment flow;
// BYO providers are reached however that provider is configured, outside this app.
const MANAGED_PROVIDER_TYPE = 'veltrix_managed'

interface ZtnaDeviceSummary {
  id: string
  name: string
  hostname: string
  addresses: string[]
  online: boolean
  lastSeen?: string
  customerTag?: string | null
}

interface ZtnaEnrollResult {
  enrollmentId: string
  authKey: string
  installCommands: string
}

interface AccessServerDetailModalProps {
  isOpen: boolean
  onClose: () => void
  server: InventoryItem | null
  connections: CredentialSummary[]
  providers: ConnectivityProviderRef[]
}

function commaList(values?: string[]): string {
  return values && values.length > 0 ? values.join(', ') : '—'
}

// Tailscale derives a device's name from the machine's hostname: it lowercases,
// strips a trailing `.local`, and turns any other punctuation into hyphens — so a
// server hostname like `splunk-sh1.babong.local` joins the tailnet as the device
// `splunk-sh1-babong`. Normalize the same way so a match survives that rewrite.
function tailscaleName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// The first DNS label of a value (`splunk-sh1-babong.tailnet.ts.net` → `splunk-sh1-babong`).
function firstLabel(value: string): string {
  return value.toLowerCase().split('.')[0]
}

// Resolves an access server to its tailnet device by hostname/name,
// case-insensitively and tolerant of Tailscale's hostname sanitization. A
// device's `name` is often a MagicDNS FQDN (`<label>.<tailnet>.ts.net`), so its
// first label is compared too.
function matchDevice(hostname: string, devices: ZtnaDeviceSummary[]): ZtnaDeviceSummary | null {
  const host = hostname.toLowerCase()
  const wanted = tailscaleName(hostname)
  return (
    devices.find((d) => {
      const dHostname = (d.hostname ?? '').toLowerCase()
      const dName = (d.name ?? '').toLowerCase()
      if (dHostname === host || dName === host || dName.startsWith(`${host}.`)) return true
      return (
        tailscaleName(dHostname) === wanted ||
        firstLabel(dName) === wanted ||
        tailscaleName(dName) === wanted
      )
    }) ?? null
  )
}

async function responseError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: string; message?: string }
      const message = body?.error ?? body?.message
      if (message) return new Error(message)
    } catch {
      // Not JSON — fall through to the raw text.
    }
    return new Error(text)
  }
  return new Error(`HTTP ${res.status}`)
}

const MUTED: React.CSSProperties = { fontSize: 13, color: 'var(--vx-text-muted, #6b7280)' }
const DT_STYLE: React.CSSProperties = { ...MUTED, margin: 0 }
const DD_STYLE: React.CSSProperties = { margin: 0, fontSize: 13 }
const DL_GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 8, margin: 0 }
const MONO: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }
const SERVICE_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 12px',
  border: '1px solid var(--vx-border, #d1d5db)',
  borderRadius: 6,
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h4
        style={{
          margin: 0,
          fontSize: 12,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: 'var(--vx-text-muted, #6b7280)',
        }}
      >
        {title}
      </h4>
      {children}
    </div>
  )
}

function CopyableBlock({ value, ariaLabel }: { value: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable (insecure context / permissions denied) — the
      // command is still selectable by hand from the code block below.
    }
  }, [value])

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: '10px 12px',
          borderRadius: 6,
          border: '1px solid var(--vx-border, #d1d5db)',
          background: 'var(--vx-surface-muted, #f3f4f6)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          overflowX: 'auto',
        }}
      >
        {value}
      </pre>
      <Button type="button" variant="secondary" size="sm" onClick={() => void handleCopy()} aria-label={ariaLabel}>
        {copied ? 'Copied!' : 'Copy'}
      </Button>
    </div>
  )
}

/**
 * Read-only detail view for one Access Server: its addressing/environment,
 * live ZTNA tailnet connectivity, a Connection test, and — for the
 * Veltrix-managed ZTNA provider only — a one-click Tailscale enrollment
 * script plus the SSH command to reach it.
 */
export default function AccessServerDetailModal({
  isOpen,
  onClose,
  server,
  connections,
  providers,
}: AccessServerDetailModalProps) {
  const toast = useToast()

  const [devices, setDevices] = useState<ZtnaDeviceSummary[] | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState<string | null>(null)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  const [enrolling, setEnrolling] = useState(false)
  const [enrollResult, setEnrollResult] = useState<ZtnaEnrollResult | null>(null)
  const [enrollError, setEnrollError] = useState<string | null>(null)

  const serverId = server?.id
  useEffect(() => {
    if (!isOpen || !serverId) return
    setDevices(null)
    setDevicesError(null)
    setDevicesLoading(true)
    let cancelled = false
    ;(async () => {
      try {
        const res = await authFetch('/api/ztna/devices')
        if (!res.ok) throw await responseError(res)
        const data = (await res.json()) as ZtnaDeviceSummary[]
        if (!cancelled) setDevices(Array.isArray(data) ? data : [])
      } catch (e) {
        if (!cancelled) setDevicesError((e as Error).message)
      } finally {
        if (!cancelled) setDevicesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOpen, serverId])

  // Reset per-action state whenever a different server is viewed (or reopened).
  useEffect(() => {
    setTestResult(null)
    setEnrollResult(null)
    setEnrollError(null)
  }, [isOpen, serverId])

  const provider = providers.find((p) => p.id === server?.connectivityProviderId)
  const connection = connections.find((c) => c.id === server?.credentialId)
  const isManaged = provider?.providerType === MANAGED_PROVIDER_TYPE

  const device = useMemo(
    () => (server && devices ? matchDevice(server.hostname, devices) : null),
    [server, devices],
  )

  // The access server is reached at its own address, not the shared connection's
  // endpoint: prefer the live tailnet IP once the device is online, else fall back
  // to the hostname. Combined with the management port, this is what the test hits.
  const testEndpoint = useMemo(() => {
    if (!server) return undefined
    const host = device?.online && device.addresses?.[0] ? device.addresses[0] : server.hostname
    if (!host) return undefined
    return server.port ? `${host}:${server.port}` : host
  }, [device, server])

  const handleTest = useCallback(async () => {
    if (!server?.credentialId) return
    setTesting(true)
    try {
      const result = await testConnection(APP_ID, server.credentialId, testEndpoint ? { endpoint: testEndpoint } : {})
      setTestResult(result)
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }, [server, testEndpoint])

  const handleEnroll = useCallback(async () => {
    if (!server) return
    setEnrolling(true)
    setEnrollError(null)
    try {
      const res = await authFetch('/api/ztna/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: server.hostname }),
      })
      if (!res.ok) throw await responseError(res)
      const data = (await res.json()) as ZtnaEnrollResult
      setEnrollResult(data)
      toast.success('Connect script generated — copy the install command now.')
    } catch (e) {
      const message = (e as Error).message
      setEnrollError(message)
      toast.error(`Failed to generate connect script: ${message}`)
    } finally {
      setEnrolling(false)
    }
  }, [server, toast])

  if (!server) return null

  const summaryRows: Array<[string, React.ReactNode]> = [
    ['Hostname', server.hostname],
    ['Management port', server.port ?? '—'],
    ['Web UI port', server.webPort ?? '—'],
    ['Type', server.type && server.type.length > 0 ? server.type.join(', ') : '—'],
    ['Environment', server.tags?.[0]?.name ?? '—'],
    ['Domains', commaList(server.domains)],
    ['IP ranges', commaList(server.ipRanges)],
    ['Connection', connection ? connection.name : server.credentialId ? 'unknown' : 'None'],
    ['ZTNA provider', provider ? provider.name : server.connectivityProviderId ? 'unknown' : 'None'],
  ]

  const sshUser = connection?.username?.trim() || '<user>'
  // The SSH command depends on the ZTNA the server is reached through:
  //  - Veltrix-managed (Tailscale) → `tailscale ssh <user>@<device>` over the
  //    tailnet (no separate SSH key needed when Tailscale SSH is enabled), plus a
  //    link to the device in the Tailscale admin console (its browser SSH lives there).
  //  - otherwise → plain `ssh <user>@<address>` (tailnet IP when online, else hostname).
  const tailnetHost = device?.name || server.hostname
  const plainAddress = device?.online && device.addresses?.[0] ? device.addresses[0] : server.hostname
  const sshCommand = isManaged ? `tailscale ssh ${sshUser}@${tailnetHost}` : `ssh ${sshUser}@${plainAddress}`
  const tailscaleAdminUrl = `https://login.tailscale.com/admin/machines?q=${encodeURIComponent(server.hostname)}`

  // Both Splunk services are reached at the server's own tailnet address: prefer
  // the live tailnet IP once the device is online, else its MagicDNS name, else the
  // configured hostname. Management defaults to 8089, Splunk Web to 8000.
  const reachHost = device?.online && device.addresses?.[0] ? device.addresses[0] : device?.name || server.hostname
  const mgmtPort = server.port?.trim() || '8089'
  const webUiPort = server.webPort?.trim() || '8000'
  // Management API is always HTTPS (8089). Splunk Web defaults to HTTP (8000) —
  // only TLS if Splunk Web SSL is explicitly enabled — so link it as http.
  const mgmtUrl = `https://${reachHost}:${mgmtPort}`
  const webUrl = `http://${reachHost}:${webUiPort}`

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`"${server.hostname}"`}
      subtitle="Access server details"
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <Section title="Server summary">
          <dl style={DL_GRID}>
            {summaryRows.map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={DT_STYLE}>{label}</dt>
                <dd style={DD_STYLE}>{value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </Section>

        <Section title="Connectivity status">
          <p style={{ margin: 0, fontSize: 13 }}>
            ZTNA provider:{' '}
            {provider ? (
              <Badge variant="secondary" size="sm">
                {provider.name}
              </Badge>
            ) : (
              <Badge variant="warning" size="sm">
                none
              </Badge>
            )}
          </p>
          {devicesLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner size="sm" />
              <span style={{ fontSize: 13 }}>Checking tailnet status…</span>
            </div>
          ) : devicesError ? (
            <Alert variant="warning">Couldn't check connectivity status: {devicesError}</Alert>
          ) : device ? (
            <dl style={DL_GRID}>
              <dt style={DT_STYLE}>Status</dt>
              <dd style={DD_STYLE}>
                <Badge variant={device.online ? 'success' : 'default'} size="sm">
                  {device.online ? 'Online' : 'Offline'}
                </Badge>
              </dd>
              <dt style={DT_STYLE}>Tailnet IP</dt>
              <dd style={DD_STYLE}>{device.addresses?.[0] ?? '—'}</dd>
              <dt style={DT_STYLE}>Last seen</dt>
              <dd style={DD_STYLE}>{device.lastSeen ? new Date(device.lastSeen).toLocaleString() : '—'}</dd>
            </dl>
          ) : (
            <p style={MUTED}>Not connected to the Veltrix network yet.</p>
          )}
        </Section>

        <Section title="Ports & services">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={SERVICE_ROW}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Splunk Web (UI)</div>
                <div style={{ ...MUTED, ...MONO }}>{webUrl}</div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.open(webUrl, '_blank', 'noopener,noreferrer')}
              >
                Open Web UI ↗
              </Button>
            </div>
            <div style={SERVICE_ROW}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Management API</div>
                <div style={{ ...MUTED, ...MONO }}>{mgmtUrl}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.open(mgmtUrl, '_blank', 'noopener,noreferrer')}
                >
                  Open ↗
                </Button>
                {server.credentialId ? (
                  <Button variant="secondary" size="sm" onClick={() => void handleTest()} isLoading={testing}>
                    Test connection
                  </Button>
                ) : (
                  <span style={MUTED}>Assign a Connection to test</span>
                )}
              </div>
            </div>
          </div>
          {testResult && (
            <Alert variant={testResult.ok ? 'success' : 'danger'} title={testResult.ok ? 'Connected' : 'Failed'}>
              {testResult.message}
              {testResult.latencyMs != null ? ` (${testResult.latencyMs} ms)` : null}
            </Alert>
          )}
          <p style={MUTED}>
            Reachable over the tailnet — open from a device connected to Tailscale that has access to this server.
            Splunk Web opens over <code style={MONO}>http</code> (its default); if this instance has Web SSL enabled,
            use <code style={MONO}>https://</code> instead.
          </p>
        </Section>

        {isManaged && (
          <Section title="Connect via Tailscale">
            <p style={MUTED}>
              Mint a fresh enrollment key, then run the install command below ON this server to join the
              Veltrix-managed tailnet.
            </p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => void handleEnroll()} isLoading={enrolling}>
                {enrollResult ? 'Regenerate' : 'Generate connect script'}
              </Button>
            </div>
            {enrollError && <Alert variant="danger">{enrollError}</Alert>}
            {enrollResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--vx-danger, #dc2626)' }}>
                  The key is shown once — copy it now.
                </p>
                <CopyableBlock value={enrollResult.installCommands} ariaLabel="Copy install command" />
              </div>
            )}
          </Section>
        )}

        <Section title="SSH access">
          <CopyableBlock value={sshCommand} ariaLabel="Copy SSH command" />
          {isManaged ? (
            <p style={{ ...MUTED, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <span>
                Tailscale SSH over the tailnet — no separate SSH key needed when Tailscale SSH is enabled on the
                server. The login user depends on the server's config; connect it to the tailnet first (see
                Connectivity status).
              </span>
              <a
                href={tailscaleAdminUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--veltrix-app-primary, #4f46e5)', fontWeight: 600 }}
              >
                Open in Tailscale (browser SSH) →
              </a>
            </p>
          ) : (
            <p style={MUTED}>The login user depends on the server's own configuration.</p>
          )}
        </Section>
      </div>
    </Modal>
  )
}
