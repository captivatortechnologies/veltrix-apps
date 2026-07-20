import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch, listCredentials, resolveTool, type CredentialSummary } from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Select,
  Textarea,
  DataTable,
  useConfirmDialog,
  type DataTableColumn,
  type SelectOption,
} from '@veltrixsecops/app-sdk/ui'

const API = '/api/apps/splunk-enterprise/licenses'
/** Platform Tool name — MUST equal the app's manifest `name` (see ConnectionsPage). */
const APP_NAME = 'Splunk Enterprise'

type LicenseStatus = 'active' | 'expiring-soon' | 'expired' | 'unknown'

interface RecordedLicense {
  id: string
  label: string
  licenseType: string
  groupId: string
  stackId: string
  quotaBytes: number
  windowPeriod: number
  maxViolations: number
  creationTime?: string | null
  expirationTime?: string | null
  guid: string
  features: string[]
  status: LicenseStatus
  daysToExpiry: number | null
}

interface LiveStack {
  stackId: string
  label: string
  type: string
  quotaBytes: number
  usedBytes: number | null
  status: string
  expirationTime: string | null
  daysToExpiry: number | null
}

interface LiveResult {
  available: boolean
  reason?: 'no-connection' | 'unreachable' | 'auth' | 'error'
  message?: string
  endpoint?: string
  stacks?: LiveStack[]
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Human-readable byte size (base 1024). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const i = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${i === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[i]}`
}

function formatDate(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

/** e.g. "in 120 days", "expires today", "12 days ago". */
function expiryHint(days: number | null): string {
  if (days == null) return 'no expiration'
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
  if (days === 0) return 'today'
  return `in ${days} day${days === 1 ? '' : 's'}`
}

function statusBadge(status: LicenseStatus): { variant: 'success' | 'warning' | 'danger' | 'default'; label: string } {
  switch (status) {
    case 'active':
      return { variant: 'success', label: 'active' }
    case 'expiring-soon':
      return { variant: 'warning', label: 'expiring soon' }
    case 'expired':
      return { variant: 'danger', label: 'expired' }
    default:
      return { variant: 'default', label: 'no expiry' }
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json()
    return typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

const MUTED: React.CSSProperties = { fontSize: 13, color: 'var(--vx-text-muted, #6b7280)' }

/**
 * Splunk Enterprise — License. Records a Splunk license XML (paste or upload),
 * tracks its quota / expiration / features / status, and — when the tenant has a
 * working Splunk Connection — shows real-time stack usage from the live
 * licenser. Rendered with the platform design-system components from
 * @veltrixsecops/app-sdk/ui; every server call goes through authFetch.
 */
export default function LicensePage() {
  const { confirm } = useConfirmDialog()
  const [licenses, setLicenses] = useState<RecordedLicense[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [xml, setXml] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const [live, setLive] = useState<LiveResult | null>(null)
  const [liveLoading, setLiveLoading] = useState(true)

  // Tenant Splunk Connections usable for a live read (management endpoint + a
  // stored secret). The live status is pulled for the selected one.
  const [connections, setConnections] = useState<CredentialSummary[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(true)
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null)

  const loadLicenses = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch(API)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: RecordedLicense[]) => setLicenses(Array.isArray(data) ? data : []))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  // Resolve the app's Tool, list its Connections, and keep only those that can
  // actually back a live read. Preserves the current selection when still valid,
  // otherwise auto-picks the first usable connection.
  const loadConnections = useCallback(() => {
    setConnectionsLoading(true)
    return (async () => {
      try {
        const tool = await resolveTool(APP_NAME)
        const creds = tool ? await listCredentials(tool.id) : []
        const usable = creds.filter((c) => Boolean(c.endpoint) && c.hasSecret)
        setConnections(usable)
        setSelectedConnId((prev) =>
          prev && usable.some((c) => c.id === prev) ? prev : (usable[0]?.id ?? null),
        )
      } catch {
        setConnections([])
        setSelectedConnId(null)
      } finally {
        setConnectionsLoading(false)
      }
    })()
  }, [])

  // Pull the live licenser status for a chosen connection. With no connection the
  // panel shows the graceful "connect a Splunk instance" empty state.
  const loadLive = useCallback((credentialId: string | null) => {
    if (!credentialId) {
      setLive({ available: false, reason: 'no-connection' })
      setLiveLoading(false)
      return Promise.resolve()
    }
    setLiveLoading(true)
    return authFetch(`${API}/live?credentialId=${encodeURIComponent(credentialId)}`)
      .then((res) => (res.ok ? res.json() : { available: false, reason: 'error' as const }))
      .then((data: LiveResult) => setLive(data))
      .catch(() => setLive({ available: false, reason: 'error' }))
      .finally(() => setLiveLoading(false))
  }, [])

  useEffect(() => {
    void loadLicenses()
    void loadConnections()
  }, [loadLicenses, loadConnections])

  // Refresh the live read once connections settle and whenever the selection
  // changes (including → null when there are none).
  useEffect(() => {
    if (connectionsLoading) return
    void loadLive(selectedConnId)
  }, [connectionsLoading, selectedConnId, loadLive])

  async function handleFile(file: File | null) {
    if (!file) return
    setFormError(null)
    try {
      setXml(await file.text())
    } catch {
      setFormError('Could not read the selected file')
    }
  }

  async function handleSubmit() {
    if (!xml.trim()) {
      setFormError('Paste or upload a Splunk license XML first')
      return
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await authFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xml }),
      })
      if (!res.ok) throw new Error(await errorText(res))
      setXml('')
      await Promise.all([loadLicenses(), loadLive(selectedConnId)])
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(row: RecordedLicense) {
    const ok = await confirm({
      title: 'Delete license',
      message: `Delete the recorded license "${row.label || row.guid}"? This removes the recorded copy only; it does not affect the license installed on any Splunk instance.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    if (!ok) return
    setDeletingId(row.id)
    try {
      const res = await authFetch(`${API}/${row.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res))
      await loadLicenses()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }

  const columns: DataTableColumn<RecordedLicense>[] = useMemo(
    () => [
      {
        key: 'label',
        header: 'License',
        render: (row) => (
          <div>
            <strong>{row.label || '(unlabeled)'}</strong>
            <div style={{ ...MUTED, marginTop: 2 }}>
              {[row.licenseType, row.groupId, row.stackId].filter(Boolean).join(' · ') || row.guid}
            </div>
          </div>
        ),
      },
      {
        key: 'quota',
        header: 'Quota / day',
        render: (row) => formatBytes(row.quotaBytes),
      },
      {
        key: 'expiration',
        header: 'Expiration',
        render: (row) => (
          <div>
            <div>{formatDate(row.expirationTime)}</div>
            <div style={MUTED}>{expiryHint(row.daysToExpiry)}</div>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        render: (row) => {
          const { variant, label } = statusBadge(row.status)
          return <Badge variant={variant}>{label}</Badge>
        },
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (row) => (
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleDelete(row)}
            isLoading={deletingId === row.id}
          >
            Delete
          </Button>
        ),
      },
    ],
    [deletingId],
  )

  const connectionOptions: SelectOption[] = useMemo(
    () =>
      connections.map((c) => ({
        value: c.id,
        label: c.endpoint ? `${c.name || c.endpoint} — ${c.endpoint}` : c.name || c.id,
      })),
    [connections],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Record a license ------------------------------------------------ */}
      <Card variant="bordered">
        <CardHeader>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Record a Splunk license</h2>
        </CardHeader>
        <CardBody>
          <p style={{ ...MUTED, marginTop: 0 }}>
            Paste the contents of a Splunk license (<code>.lic</code>) file, or upload it. The license is parsed and
            recorded so its quota, expiration and features are tracked here — no Splunk connection required.
          </p>
          <Textarea
            label="License XML"
            value={xml}
            onChange={(e) => setXml(e.target.value)}
            placeholder="<license><signature>…</signature><payload>…</payload></license>"
            rows={8}
            fullWidth
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
            <label style={{ ...MUTED, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>or upload a file:</span>
              <input
                type="file"
                accept=".lic,.xml,text/xml,application/xml"
                onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <div style={{ flex: 1 }} />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSubmit()}
              isLoading={submitting}
              disabled={!xml.trim()}
            >
              Record license
            </Button>
          </div>
          {formError ? (
            <p role="alert" style={{ color: 'var(--vx-danger, #dc2626)', fontSize: 13, marginBottom: 0 }}>
              {formError}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* Live licenser status ------------------------------------------- */}
      <Card variant="bordered">
        <CardHeader
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {connections.length > 1 ? (
                <Select
                  aria-label="Splunk connection"
                  options={connectionOptions}
                  value={selectedConnId ?? undefined}
                  onChange={(value) => setSelectedConnId(value)}
                  size="sm"
                  fullWidth={false}
                  disabled={liveLoading}
                />
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadLive(selectedConnId)}
                isLoading={liveLoading || connectionsLoading}
              >
                Refresh
              </Button>
            </div>
          }
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Live licenser status</h2>
        </CardHeader>
        <CardBody>
          <LivePanel live={live} loading={liveLoading || connectionsLoading} />
        </CardBody>
      </Card>

      {/* Recorded licenses --------------------------------------------- */}
      <Card variant="bordered">
        <CardHeader
          actions={
            <Button variant="secondary" size="sm" onClick={() => void loadLicenses()} isLoading={isLoading}>
              Refresh
            </Button>
          }
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Recorded licenses</h2>
        </CardHeader>
        <CardBody>
          {error ? (
            <p role="alert">Failed to load licenses: {error}</p>
          ) : (
            <DataTable
              columns={columns}
              data={licenses}
              rowKey={(row) => row.id}
              isLoading={isLoading}
              emptyState={{
                title: 'No licenses recorded',
                description: 'Paste or upload a Splunk license above to start tracking its quota and expiration.',
              }}
            />
          )}
        </CardBody>
      </Card>
    </div>
  )
}

/** Live status body: usage-vs-quota per stack, or a graceful degraded note. */
function LivePanel({ live, loading }: { live: LiveResult | null; loading: boolean }) {
  if (loading && !live) return <p style={MUTED}>Checking live status…</p>
  if (!live) return null

  if (!live.available) {
    if (live.reason === 'no-connection') {
      return (
        <p style={MUTED}>
          Connect a Splunk instance on the <strong>Connections</strong> page to see live license usage and status.
        </p>
      )
    }
    return (
      <p style={MUTED}>
        Live status unavailable{live.message ? `: ${live.message}` : ''}. The recorded license data below is still
        current.
      </p>
    )
  }

  const stacks = live.stacks ?? []
  if (stacks.length === 0) {
    return <p style={MUTED}>Connected to {live.endpoint}, but no license stacks were reported.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {live.endpoint ? <p style={{ ...MUTED, margin: 0 }}>Live from {live.endpoint}</p> : null}
      {stacks.map((stack) => (
        <LiveStackRow key={stack.stackId} stack={stack} />
      ))}
    </div>
  )
}

function LiveStackRow({ stack }: { stack: LiveStack }) {
  const pct =
    stack.usedBytes != null && stack.quotaBytes > 0
      ? Math.min(100, Math.round((stack.usedBytes / stack.quotaBytes) * 100))
      : null
  const over = pct != null && pct >= 100
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <strong>{stack.label || stack.stackId}</strong>
        <span style={MUTED}>
          {stack.usedBytes != null ? `${formatBytes(stack.usedBytes)} / ` : ''}
          {formatBytes(stack.quotaBytes)} per day
          {pct != null ? ` (${pct}%)` : ''}
        </span>
      </div>
      <div
        aria-hidden
        style={{
          height: 8,
          borderRadius: 4,
          background: 'var(--vx-surface-muted, #e5e7eb)',
          overflow: 'hidden',
          marginTop: 6,
        }}
      >
        <div
          style={{
            width: `${pct ?? 0}%`,
            height: '100%',
            background: over ? 'var(--vx-danger, #dc2626)' : 'var(--veltrix-app-primary, #FF6600)',
            transition: 'width 200ms ease',
          }}
        />
      </div>
      <div style={{ ...MUTED, marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {stack.status ? <span>Splunk status: {stack.status}</span> : null}
        {stack.expirationTime ? <span>Expires {formatDate(stack.expirationTime)}</span> : null}
      </div>
    </div>
  )
}
