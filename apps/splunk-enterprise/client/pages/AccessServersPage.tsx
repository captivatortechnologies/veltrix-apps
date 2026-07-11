import React, { useCallback, useEffect, useState } from 'react'
import {
  listInventory,
  addInventoryItem,
  updateInventoryItem,
  removeInventoryItem,
  listCredentials,
  listConnectivityProviders,
  resolveTool,
  type InventoryItem,
  type CredentialSummary,
  type ConnectivityProviderRef,
} from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Input,
  Select,
  FormDialog,
  DataTable,
  type DataTableColumn,
} from '@veltrixsecops/app-sdk/ui'

// The platform Tool is upserted keyed by the app's manifest name; resolveTool
// matches on it so new access servers attach to this app's tool.
const APP_NAME = 'Splunk Enterprise'

// Splunk server (component) types this app deploys to. A component's `type` is
// an array; the form edits a single primary type.
const SERVER_TYPES = [
  { value: 'indexer', label: 'Indexer' },
  { value: 'search-head', label: 'Search Head' },
  { value: 'cluster-manager', label: 'Cluster Manager' },
  { value: 'heavy-forwarder', label: 'Heavy Forwarder' },
  { value: 'universal-forwarder', label: 'Universal Forwarder' },
  { value: 'deployment-server', label: 'Deployment Server' },
  { value: 'deployer', label: 'Deployer' },
  { value: 'license-server', label: 'License Server' },
  { value: 'sc4s', label: 'SC4S' },
]
const SPLUNK_TYPES = new Set(SERVER_TYPES.map((t) => t.value))

const NONE_OPTION = { value: '', label: '— None —' }

function isSplunkTarget(item: InventoryItem): boolean {
  if (!item.type || item.type.length === 0) return true
  return item.type.some((t) => SPLUNK_TYPES.has(t))
}

function commaList(values?: string[]): string {
  return values && values.length > 0 ? values.join(', ') : '—'
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

interface FormState {
  hostname: string
  port: string
  type: string
  domains: string
  ipRanges: string
  credentialId: string
  connectivityProviderId: string
}

const BLANK_FORM: FormState = {
  hostname: '',
  port: '8089',
  type: 'indexer',
  domains: '',
  ipRanges: '',
  credentialId: '',
  connectivityProviderId: '',
}

/**
 * Access Servers — the Splunk servers this app deploys to (indexers, search
 * heads, cluster managers, forwarders …): their IPs/domains/types, plus the
 * Connection (credential) used to reach them and the ZTNA connectivity provider
 * they are reached through. Backed by the platform's deployment targets
 * (components); configs deploy through these.
 */
export default function AccessServersPage() {
  const [servers, setServers] = useState<InventoryItem[]>([])
  const [connections, setConnections] = useState<CredentialSummary[]>([])
  const [providers, setProviders] = useState<ConnectivityProviderRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<InventoryItem | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const tool = await resolveTool(APP_NAME)
      const [components, creds, provs] = await Promise.all([
        listInventory(),
        tool ? listCredentials(tool.id) : Promise.resolve([] as CredentialSummary[]),
        listConnectivityProviders(),
      ])
      setServers(components.filter(isSplunkTarget))
      setConnections(creds)
      setProviders(provs)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const connectionName = (id?: string | null) => connections.find((c) => c.id === id)?.name
  const providerName = (id?: string | null) => providers.find((p) => p.id === id)?.name

  const openCreate = () => {
    setEditing(null)
    setForm(BLANK_FORM)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: InventoryItem) => {
    setEditing(row)
    setForm({
      hostname: row.hostname ?? '',
      port: row.port ?? '8089',
      type: row.type?.[0] ?? 'indexer',
      domains: (row.domains ?? []).join(', '),
      ipRanges: (row.ipRanges ?? []).join(', '),
      credentialId: row.credentialId ?? '',
      connectivityProviderId: row.connectivityProviderId ?? '',
    })
    setFormError(null)
    setDialogOpen(true)
  }

  // Memoized so FormDialog's focus effect doesn't steal focus while typing.
  const closeDialog = useCallback(() => {
    if (submitting) return
    setDialogOpen(false)
  }, [submitting])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSubmit = async () => {
    const hostname = form.hostname.trim()
    if (!hostname) {
      setFormError('Hostname is required')
      return
    }
    setSubmitting(true)
    setFormError(null)

    const payload = {
      hostname,
      port: form.port.trim() || '8089',
      type: [form.type],
      domains: splitCsv(form.domains),
      ipRanges: splitCsv(form.ipRanges),
      credentialId: form.credentialId || null,
      connectivityProviderId: form.connectivityProviderId || null,
    }

    try {
      if (editing) {
        await updateInventoryItem(editing.id, payload)
      } else {
        const tool = await resolveTool(APP_NAME)
        if (!tool) {
          throw new Error(
            `No "${APP_NAME}" tool found for your organization — make sure the app is installed before adding access servers.`,
          )
        }
        await addInventoryItem({ ...payload, toolId: tool.id })
      }
      setDialogOpen(false)
      await load()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (row: InventoryItem) => {
    if (!window.confirm(`Remove access server "${row.hostname}"? This cannot be undone.`)) return
    try {
      await removeInventoryItem(row.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const columns: DataTableColumn<InventoryItem>[] = [
    { key: 'hostname', header: 'Hostname', render: (row) => <strong>{row.hostname}</strong> },
    {
      key: 'type',
      header: 'Type',
      render: (row) =>
        row.type && row.type.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {row.type.map((t) => (
              <Badge key={t} variant="secondary" size="sm">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          '—'
        ),
    },
    { key: 'domains', header: 'Domains', render: (row) => commaList(row.domains) },
    { key: 'ipRanges', header: 'IP ranges', render: (row) => commaList(row.ipRanges) },
    {
      key: 'connection',
      header: 'Connection',
      render: (row) =>
        row.credentialId ? (
          <Badge variant="info" size="sm">
            {connectionName(row.credentialId) ?? 'unknown'}
          </Badge>
        ) : (
          <Badge variant="warning" size="sm">
            none
          </Badge>
        ),
    },
    {
      key: 'ztna',
      header: 'Connectivity (ZTNA)',
      render: (row) =>
        row.connectivityProviderId ? (
          <Badge variant="secondary" size="sm">
            {providerName(row.connectivityProviderId) ?? 'unknown'}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleDelete(row)}>
            Remove
          </Button>
        </div>
      ),
    },
  ]

  const connectionOptions = [NONE_OPTION, ...connections.map((c) => ({ value: c.id, label: c.name }))]
  const providerOptions = [NONE_OPTION, ...providers.map((p) => ({ value: p.id, label: p.name }))]

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              Add access server
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Access Servers</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load access servers: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={servers}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No access servers yet',
              description:
                'Add a Splunk server (indexer, search head, cluster manager, forwarder …), then pick the Connection and ZTNA used to reach it.',
            }}
          />
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit "${editing.hostname}"` : 'Add access server'}
        description="A Splunk deployment target — its addressing, plus the Connection and ZTNA used to reach it."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Add access server'}
        isSubmitting={submitting}
        submitDisabled={!form.hostname.trim()}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Input
              label="Hostname"
              value={form.hostname}
              onChange={(e) => setField('hostname', e.target.value)}
              placeholder="e.g. idx1.splunk.internal"
              fullWidth
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <Input
              label="Management port"
              value={form.port}
              onChange={(e) => setField('port', e.target.value)}
              placeholder="8089"
              fullWidth
            />
          </div>
          <Select
            label="Type"
            options={SERVER_TYPES}
            value={form.type}
            onChange={(value) => setField('type', value)}
            fullWidth
          />
          <Input
            label="Domains (optional)"
            value={form.domains}
            onChange={(e) => setField('domains', e.target.value)}
            placeholder="comma-separated DNS names, e.g. idx1.corp.example.com"
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          <Input
            label="IP ranges (optional)"
            value={form.ipRanges}
            onChange={(e) => setField('ipRanges', e.target.value)}
            placeholder="comma-separated IP/CIDR, e.g. 10.0.1.0/24"
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          <Select
            label="Connection"
            options={connectionOptions}
            value={form.credentialId}
            onChange={(value) => setField('credentialId', value)}
            helperText="The connection (credential) used to reach this server. Manage under Settings → Connections."
            fullWidth
          />
          <Select
            label="Connectivity (ZTNA)"
            options={providerOptions}
            value={form.connectivityProviderId}
            onChange={(value) => setField('connectivityProviderId', value)}
            helperText="The Zero-Trust provider this server is reached through. Manage under Settings → Connectivity."
            fullWidth
          />
        </div>
      </FormDialog>
    </Card>
  )
}
