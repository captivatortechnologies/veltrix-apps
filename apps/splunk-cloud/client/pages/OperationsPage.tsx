import React, { useCallback, useEffect, useState } from 'react'
import { listCredentials, resolveTool, runOperation } from '@veltrixsecops/app-sdk/client'
import type { CredentialSummary, OperationResult } from '@veltrixsecops/app-sdk/client'
import { Card, CardHeader, CardBody, Button, Badge, Input, Select } from '@veltrixsecops/app-sdk/ui'

const APP_ID = 'splunk-cloud'
const APP_NAME = 'Splunk Cloud Platform'

type OpState = { loading: true } | OperationResult

/**
 * Operations — one-off stack actions (restart, retry failed operation, export
 * app) run against a chosen connection via the app's operation handlers. Not
 * configuration deploys: each button calls
 * POST /api/apps/splunk-cloud/operations/:operationId (SDK `runOperation`),
 * which decrypts the connection's JWT and runs the handler in-process.
 */
export default function OperationsPage() {
  const [connections, setConnections] = useState<CredentialSummary[]>([])
  const [credentialId, setCredentialId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [exportAppName, setExportAppName] = useState('')
  const [results, setResults] = useState<Record<string, OpState>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const tool = await resolveTool(APP_NAME)
      const creds = tool ? await listCredentials(tool.id) : []
      setConnections(creds)
      setCredentialId((prev) => prev || (creds[0]?.id ?? ''))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const isRunning = (opId: string) => {
    const s = results[opId]
    return !!s && 'loading' in s
  }

  const run = async (opId: string, params?: Record<string, unknown>, confirmMsg?: string) => {
    if (!credentialId) {
      setResults((r) => ({ ...r, [opId]: { ok: false, message: 'Select a connection first.' } }))
      return
    }
    if (confirmMsg && typeof window !== 'undefined' && !window.confirm(confirmMsg)) return
    setResults((r) => ({ ...r, [opId]: { loading: true } }))
    try {
      const res = await runOperation(APP_ID, opId, { credentialId, params })
      setResults((r) => ({ ...r, [opId]: res }))
      if (res.ok && opId === 'export-app' && res.data && (res.data as { base64?: string }).base64) {
        triggerDownload(res.data as Record<string, unknown>)
      }
    } catch (e) {
      setResults((r) => ({ ...r, [opId]: { ok: false, message: (e as Error).message } }))
    }
  }

  const triggerDownload = (data: Record<string, unknown>) => {
    try {
      const bytes = Uint8Array.from(atob(String(data.base64 || '')), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: String(data.contentType || 'application/gzip') })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = String(data.filename || 'export.tar.gz')
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* download is best-effort; the result message already reports success */
    }
  }

  const connectionOptions = [
    { value: '', label: connections.length ? '— Select a connection —' : '— No connections —' },
    ...connections.map((c) => ({ value: c.id, label: `${c.name}${c.username ? ` (${c.username})` : ''}` })),
  ]

  const muted = 'var(--color-muted, #6b7280)'
  const border = 'var(--color-border, #e5e7eb)'

  const ResultLine = ({ opId }: { opId: string }) => {
    const state = results[opId]
    if (!state) return null
    if ('loading' in state) return <div style={{ marginTop: 8, fontSize: 13, color: muted }}>Running…</div>
    return (
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Badge variant={state.ok ? 'success' : 'danger'} size="sm">
          {state.ok ? '✓' : '✗'}
        </Badge>
        <div style={{ fontSize: 13 }}>
          <div style={{ color: state.ok ? 'var(--color-success, #16a34a)' : 'var(--color-danger, #dc2626)' }}>
            {state.message}
          </div>
          {state.details && state.details.length > 0 ? (
            <ul style={{ margin: '4px 0 0', paddingLeft: 16, color: muted }}>
              {state.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    )
  }

  const Row = ({
    title,
    description,
    children,
  }: {
    title: string
    description: string
    children: React.ReactNode
  }) => (
    <div style={{ borderTop: `1px solid ${border}`, paddingTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 520 }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 13, color: muted }}>{description}</div>
        </div>
        {children}
      </div>
    </div>
  )

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={loading}>
            Refresh
          </Button>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Operations</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load connections: {error}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ maxWidth: 460 }}>
              <Select
                label="Connection"
                options={connectionOptions}
                value={credentialId}
                onChange={setCredentialId}
                helperText="The Splunk Cloud connection (stack + JWT) each operation authenticates with. ACS operations need a paid multi-search-head stack."
                fullWidth
              />
            </div>

            <Row
              title="Restart Stack"
              description="Initiate a (rolling) restart of the search head / SHC via ACS. Search may be briefly unavailable."
            >
              <div>
                <ResultLine opId="restart" />
                <Button
                  variant="danger"
                  size="sm"
                  isLoading={isRunning('restart')}
                  onClick={() =>
                    void run(
                      'restart',
                      undefined,
                      'Restart the selected Splunk Cloud stack now? A rolling restart can take several minutes and search may be briefly unavailable.',
                    )
                  }
                >
                  Restart
                </Button>
              </div>
            </Row>

            <Row
              title="Retry Failed Operation"
              description="Re-submit the latest failed ACS operation (private-app install / HEC token management). Runs asynchronously."
            >
              <div>
                <ResultLine opId="retry-failed" />
                <Button variant="secondary" size="sm" isLoading={isRunning('retry-failed')} onClick={() => void run('retry-failed')}>
                  Retry
                </Button>
              </div>
            </Row>

            <div style={{ borderTop: `1px solid ${border}`, paddingTop: 16 }}>
              <div style={{ fontWeight: 600 }}>Export App</div>
              <div style={{ fontSize: 13, color: muted, marginBottom: 8 }}>
                Download an installed private app as a <code>.tar.gz</code> (Victoria Experience; requires the{' '}
                <code>export_apps</code> capability).
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 260 }}>
                  <Input
                    label="App name"
                    value={exportAppName}
                    onChange={(e) => setExportAppName(e.target.value)}
                    placeholder="e.g. my_custom_app"
                    fullWidth
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  isLoading={isRunning('export-app')}
                  onClick={() => void run('export-app', { appName: exportAppName.trim() })}
                >
                  Export &amp; Download
                </Button>
              </div>
              <ResultLine opId="export-app" />
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
