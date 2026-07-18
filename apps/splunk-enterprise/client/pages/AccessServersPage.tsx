import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  listInventory,
  addInventoryItem,
  updateInventoryItem,
  removeInventoryItem,
  listCredentials,
  listConnectivityProviders,
  listEnvironments,
  resolveTool,
  type InventoryItem,
  type CredentialSummary,
  type ConnectivityProviderRef,
  type EnvironmentRef,
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
  FilterBar,
  SortSelect,
  Pagination,
  useConfirmDialog,
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
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
  environmentId: string
  domains: string
  ipRanges: string
  credentialId: string
  connectivityProviderId: string
}

const BLANK_FORM: FormState = {
  hostname: '',
  port: '8089',
  type: 'indexer',
  environmentId: '',
  domains: '',
  ipRanges: '',
  credentialId: '',
  connectivityProviderId: '',
}

/**
 * Access Servers — the Splunk servers this app deploys to (indexers, search
 * heads, cluster managers, forwarders …): their IPs/domains/types, the
 * Environment they belong to (which determines where configs are pushed), the
 * Connection (credential) used to reach them, and the ZTNA provider they are
 * reached through. Backed by the platform's deployment targets (components).
 */
export default function AccessServersPage() {
  const { confirm } = useConfirmDialog()
  const [servers, setServers] = useState<InventoryItem[]>([])
  const [connections, setConnections] = useState<CredentialSummary[]>([])
  const [providers, setProviders] = useState<ConnectivityProviderRef[]>([])
  const [environments, setEnvironments] = useState<EnvironmentRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Search / filter / sort / pagination — the page owns the list state,
  // DataTable just renders whatever page of rows results.
  const [search, setSearch] = useState('')
  const [environmentFilter, setEnvironmentFilter] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [providerFilter, setProviderFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('hostname')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

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
      const [components, creds, provs, envs] = await Promise.all([
        listInventory(),
        tool ? listCredentials(tool.id) : Promise.resolve([] as CredentialSummary[]),
        listConnectivityProviders(),
        listEnvironments(),
      ])
      setServers(components.filter(isSplunkTarget))
      setConnections(creds)
      setProviders(provs)
      setEnvironments(envs)
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
      environmentId: row.tags?.[0]?.id ?? '',
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
    if (!form.environmentId) {
      setFormError('Environment is required')
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
      tagIds: [form.environmentId],
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
    const ok = await confirm({
      title: 'Remove access server',
      message: `Remove access server "${row.hostname}"? This cannot be undone.`,
      confirmText: 'Remove',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    if (!ok) return
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
      key: 'environment',
      header: 'Environment',
      render: (row) =>
        row.tags && row.tags.length > 0 ? (
          <Badge variant="info" size="sm">
            {row.tags[0].name}
          </Badge>
        ) : (
          <Badge variant="warning" size="sm">
            none
          </Badge>
        ),
    },
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
          <Badge variant="secondary" size="sm">
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

  const environmentOptions = [
    { value: '', label: environments.length ? '— Select environment —' : '— No environments —' },
    ...environments.map((e) => ({ value: e.id, label: e.name })),
  ]
  const connectionOptions = [NONE_OPTION, ...connections.map((c) => ({ value: c.id, label: c.name }))]
  const providerOptions = [NONE_OPTION, ...providers.map((p) => ({ value: p.id, label: p.name }))]

  // Toolbar filter/sort option lists.
  const environmentFilterOptions = environments.map((e) => ({ value: e.id, label: e.name }))
  const typeFilterOptions = SERVER_TYPES
  const providerFilterOptions = providers.map((p) => ({ value: p.id, label: p.name }))
  const sortOptions: SortOption[] = [
    { value: 'hostname', label: 'Hostname' },
    { value: 'environment', label: 'Environment' },
    { value: 'type', label: 'Type' },
  ]
  const filters: FilterDefinition[] = [
    {
      key: 'environment',
      label: 'Environment',
      options: environmentFilterOptions,
      value: environmentFilter,
      onChange: setEnvironmentFilter,
      alwaysVisible: true,
    },
    {
      key: 'type',
      label: 'Type',
      options: typeFilterOptions,
      value: typeFilter,
      onChange: setTypeFilter,
      alwaysVisible: true,
    },
    {
      key: 'connectivity',
      label: 'Connectivity (ZTNA)',
      options: providerFilterOptions,
      value: providerFilter,
      onChange: setProviderFilter,
    },
  ]

  // search -> filter -> sort, then slice to the current page.
  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = servers.filter((row) => {
      if (term) {
        const haystack = `${row.hostname ?? ''} ${(row.domains ?? []).join(' ')} ${(row.ipRanges ?? []).join(' ')}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (environmentFilter && row.tags?.[0]?.id !== environmentFilter) return false
      if (typeFilter && !row.type?.includes(typeFilter)) return false
      if (providerFilter && row.connectivityProviderId !== providerFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortField) {
        case 'environment':
          return (a.tags?.[0]?.name ?? '').localeCompare(b.tags?.[0]?.name ?? '') * dir
        case 'type':
          return (a.type?.[0] ?? '').localeCompare(b.type?.[0] ?? '') * dir
        case 'hostname':
        default:
          return (a.hostname ?? '').localeCompare(b.hostname ?? '') * dir
      }
    })
  }, [servers, search, environmentFilter, typeFilter, providerFilter, sortField, sortDir])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  // Any change to search/filters/sort invalidates the current page.
  useEffect(() => {
    setPage(1)
  }, [search, environmentFilter, typeFilter, providerFilter, sortField, sortDir])

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
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <FilterBar
                search={{ value: search, onChange: setSearch, placeholder: 'Search access servers…' }}
                filters={filters}
                onClearAll={() => {
                  setSearch('')
                  setEnvironmentFilter(null)
                  setTypeFilter(null)
                  setProviderFilter(null)
                }}
              />
              <SortSelect
                options={sortOptions}
                value={sortField}
                direction={sortDir}
                onChange={(field, direction) => {
                  setSortField(field)
                  setSortDir(direction)
                }}
              />
            </div>
            <DataTable
              columns={columns}
              data={pageRows}
              rowKey={(row) => row.id}
              isLoading={isLoading}
              emptyState={{
                title: 'No access servers yet',
                description:
                  'Add a Splunk server (indexer, search head, cluster manager, forwarder …), assign its environment, then pick the Connection and ZTNA used to reach it.',
              }}
            />
            <div style={{ marginTop: 12 }}>
              <Pagination
                page={page}
                pageSize={pageSize}
                totalItems={filteredSorted.length}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                pageSizeOptions={[10, 25, 50]}
              />
            </div>
          </>
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit "${editing.hostname}"` : 'Add access server'}
        description="A Splunk deployment target — its addressing + environment, plus the Connection and ZTNA used to reach it."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Add access server'}
        isSubmitting={submitting}
        submitDisabled={!form.hostname.trim() || !form.environmentId}
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
            label="Environment"
            options={environmentOptions}
            value={form.environmentId}
            onChange={(value) => setField('environmentId', value)}
            helperText="The deployment scope this server belongs to — configs deploy here per environment. Manage under Environments."
            fullWidth
          />
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
