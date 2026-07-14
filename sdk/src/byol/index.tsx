import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch } from '../client'
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
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
} from '../ui'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ByolInfrastructure {
  id: string
  name: string
  deploymentType?: string
  environmentType?: string
  indexerCount?: number
  searchHeadCount?: number
  status?: string
  hosting_type?: string
  cloudProviderId?: string | null
  region?: string | null
  updatedAt?: string
}

/** Platform tag — the customer's environment tags feed the Environment picker. */
interface Tag {
  id: string
  name: string
}

/** Platform cloud provider — feeds the "Provider" picker (plus Self-Hosted). */
interface CloudProvider {
  id: string
  name: string
  code?: string
  isActive?: boolean
}

interface CloudRegion {
  id: string
  name: string
  code: string
  isActive?: boolean
}

interface FormState {
  name: string
  deploymentType: string
  environmentType: string
  /** A cloud provider id, or the SELF_HOSTED sentinel. */
  providerId: string
  region: string
  indexerCount: string
  searchHeadCount: string
}

export interface ByolInfrastructureManagerProps {
  /** Base URL of the app's BYOL routes, e.g. `/api/apps/splunk-enterprise/byol`. */
  apiBase: string
  /** Card title. Defaults to "BYOL Infrastructure". */
  title?: string
  /** Deployment topology options. Defaults to Single instance + Distributed. */
  deploymentTypes?: Array<{ value: string; label: string }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel provider value for a customer-managed (non-cloud) deployment. */
const SELF_HOSTED = 'self-hosted'
const SELF_HOSTED_LABEL = 'Self-Hosted'

const DEFAULT_DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single instance' },
  { value: 'distributed', label: 'Distributed' },
]

const BLANK_FORM: FormState = {
  name: '',
  deploymentType: 'single',
  environmentType: '',
  providerId: '',
  region: '',
  indexerCount: '1',
  searchHeadCount: '1',
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  active: 'success',
  running: 'success',
  provisioning: 'warning',
  stopped: 'warning',
  failed: 'danger',
  error: 'danger',
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

async function errorText(res: Response): Promise<string> {
  return res
    .json()
    .then((b: { error?: string }) => b?.error || `HTTP ${res.status}`)
    .catch(() => `HTTP ${res.status}`)
}

/**
 * Reusable BYOL infrastructure manager: full CRUD + lifecycle over an app's
 * `/byol` routes, with a Provider picker (platform cloud providers plus
 * Self-Hosted), an Environment picker fed by the customer's tags, and a cloud
 * region picker shown only for a distributed cloud deployment. The app owns the
 * data (its own DB table + routes); this component owns only the UI.
 */
export const ByolInfrastructureManager: React.FC<ByolInfrastructureManagerProps> = ({
  apiBase,
  title = 'BYOL Infrastructure',
  deploymentTypes = DEFAULT_DEPLOYMENT_TYPES,
}) => {
  const [infrastructure, setInfrastructure] = useState<ByolInfrastructure[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [cloudProviders, setCloudProviders] = useState<CloudProvider[]>([])
  const [regions, setRegions] = useState<CloudRegion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [environmentFilter, setEnvironmentFilter] = useState<string | null>(null)
  const [deploymentFilter, setDeploymentFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ByolInfrastructure | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch(apiBase)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: ByolInfrastructure[]) => setInfrastructure(Array.isArray(data) ? data : []))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [apiBase])

  useEffect(() => {
    void load()
  }, [load])

  // Reference lists: environment tags + platform cloud providers. Best-effort.
  useEffect(() => {
    authFetch('/api/tags')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Tag[]) => setTags(Array.isArray(data) ? data : []))
      .catch(() => setTags([]))
    authFetch('/api/cloud-providers')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CloudProvider[]) =>
        setCloudProviders(Array.isArray(data) ? data.filter((c) => c.isActive !== false) : []),
      )
      .catch(() => setCloudProviders([]))
  }, [])

  const isCloud = form.providerId !== '' && form.providerId !== SELF_HOSTED
  const showRegion = isCloud && form.deploymentType === 'distributed'

  // Load the selected cloud provider's regions when needed for the region picker.
  useEffect(() => {
    if (!isCloud) {
      setRegions([])
      return
    }
    let cancelled = false
    authFetch(`/api/cloud-providers/${form.providerId}/regions`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CloudRegion[]) => {
        if (!cancelled) setRegions(Array.isArray(data) ? data.filter((r) => r.isActive !== false) : [])
      })
      .catch(() => {
        if (!cancelled) setRegions([])
      })
    return () => {
      cancelled = true
    }
  }, [isCloud, form.providerId])

  const openCreate = () => {
    setEditing(null)
    setForm(BLANK_FORM)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: ByolInfrastructure) => {
    const providerId = row.cloudProviderId
      ? row.cloudProviderId
      : row.hosting_type === SELF_HOSTED_LABEL
        ? SELF_HOSTED
        : ''
    setEditing(row)
    setForm({
      name: row.name ?? '',
      deploymentType: row.deploymentType ?? 'single',
      environmentType: row.environmentType ?? '',
      providerId,
      region: row.region ?? '',
      indexerCount: String(row.indexerCount ?? 1),
      searchHeadCount: String(row.searchHeadCount ?? 1),
    })
    setFormError(null)
    setDialogOpen(true)
  }

  const closeDialog = useCallback(() => {
    if (submitting) return
    setDialogOpen(false)
  }, [submitting])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    const indexerCount = Number(form.indexerCount)
    const searchHeadCount = Number(form.searchHeadCount)
    if (form.deploymentType === 'distributed') {
      if (indexerCount < 3) {
        setFormError('Distributed deployments require at least 3 indexers')
        return
      }
      if (searchHeadCount < 2) {
        setFormError('Distributed deployments require at least 2 search heads')
        return
      }
    }
    const selfHosted = form.providerId === SELF_HOSTED
    const selectedCloud = cloudProviders.find((c) => c.id === form.providerId)
    setSubmitting(true)
    setFormError(null)
    const payload = {
      name: form.name.trim(),
      deploymentType: form.deploymentType,
      environmentType: form.environmentType,
      hosting_type: selfHosted ? SELF_HOSTED_LABEL : (selectedCloud?.name ?? ''),
      cloudProviderId: selfHosted ? undefined : form.providerId || undefined,
      region: showRegion ? form.region : '',
      indexerCount,
      searchHeadCount,
    }
    try {
      const res = await authFetch(editing ? `${apiBase}/${editing.id}` : apiBase, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await errorText(res))
      setDialogOpen(false)
      await load()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (row: ByolInfrastructure) => {
    if (!window.confirm(`Delete BYOL infrastructure "${row.name}"? This cannot be undone.`)) return
    try {
      const res = await authFetch(`${apiBase}/${row.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res))
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleLifecycle = async (row: ByolInfrastructure, action: 'start' | 'stop' | 'restart') => {
    setBusyId(row.id)
    setError(null)
    try {
      const res = await authFetch(`${apiBase}/${row.id}/${action}`, { method: 'POST' })
      if (!res.ok) throw new Error(await errorText(res))
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const columns: DataTableColumn<ByolInfrastructure>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'deploymentType', header: 'Deployment', render: (row) => row.deploymentType ?? '—' },
    { key: 'environmentType', header: 'Environment', render: (row) => row.environmentType ?? '—' },
    { key: 'hosting_type', header: 'Provider', render: (row) => row.hosting_type ?? '—' },
    { key: 'region', header: 'Region', render: (row) => row.region || '—' },
    { key: 'indexerCount', header: 'Indexers', align: 'right', render: (row) => row.indexerCount ?? '—' },
    { key: 'searchHeadCount', header: 'Search heads', align: 'right', render: (row) => row.searchHeadCount ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge variant={row.status ? STATUS_VARIANT[row.status] ?? 'default' : 'default'}>
          {row.status ?? 'unknown'}
        </Badge>
      ),
    },
    { key: 'updatedAt', header: 'Updated', render: (row) => formatDate(row.updatedAt) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        const isRunning = row.status === 'running'
        const isBusy = busyId === row.id
        return (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button variant="ghost" size="sm" disabled={isRunning || isBusy} onClick={() => void handleLifecycle(row, 'start')}>
              Start
            </Button>
            <Button variant="ghost" size="sm" disabled={!isRunning || isBusy} onClick={() => void handleLifecycle(row, 'stop')}>
              Stop
            </Button>
            <Button variant="ghost" size="sm" disabled={!isRunning || isBusy} onClick={() => void handleLifecycle(row, 'restart')}>
              Restart
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void handleDelete(row)}>
              Delete
            </Button>
          </div>
        )
      },
    },
  ]

  const environmentOptions = useMemo(() => tags.map((t) => ({ value: t.name, label: t.name })), [tags])
  const providerOptions = useMemo(
    () => [
      { value: SELF_HOSTED, label: SELF_HOSTED_LABEL },
      ...cloudProviders.map((c) => ({ value: c.id, label: c.name })),
    ],
    [cloudProviders],
  )
  const regionOptions = useMemo(
    () => regions.map((r) => ({ value: r.code, label: `${r.name} (${r.code})` })),
    [regions],
  )

  const statusFilterOptions = useMemo(() => {
    const seen = new Set<string>()
    infrastructure.forEach((i) => seen.add(i.status ?? 'unknown'))
    return Array.from(seen, (value) => ({ value, label: value }))
  }, [infrastructure])

  const sortOptions: SortOption[] = [
    { value: 'name', label: 'Name' },
    { value: 'indexerCount', label: 'Indexers' },
    { value: 'searchHeadCount', label: 'Search heads' },
    { value: 'status', label: 'Status' },
    { value: 'updatedAt', label: 'Updated' },
  ]
  const filters: FilterDefinition[] = [
    { key: 'environment', label: 'Environment', options: environmentOptions, value: environmentFilter, onChange: setEnvironmentFilter, alwaysVisible: true },
    { key: 'deployment', label: 'Deployment', options: deploymentTypes, value: deploymentFilter, onChange: setDeploymentFilter },
    { key: 'status', label: 'Status', options: statusFilterOptions, value: statusFilter, onChange: setStatusFilter },
  ]

  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = infrastructure.filter((row) => {
      if (term) {
        const haystack = `${row.name ?? ''} ${row.hosting_type ?? ''} ${row.region ?? ''}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (environmentFilter && row.environmentType !== environmentFilter) return false
      if (deploymentFilter && row.deploymentType !== deploymentFilter) return false
      if (statusFilter && (row.status ?? 'unknown') !== statusFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortField) {
        case 'indexerCount':
          return ((a.indexerCount ?? 0) - (b.indexerCount ?? 0)) * dir
        case 'searchHeadCount':
          return ((a.searchHeadCount ?? 0) - (b.searchHeadCount ?? 0)) * dir
        case 'status':
          return (a.status ?? '').localeCompare(b.status ?? '') * dir
        case 'updatedAt':
          return (new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime()) * dir
        case 'name':
        default:
          return (a.name ?? '').localeCompare(b.name ?? '') * dir
      }
    })
  }, [infrastructure, search, environmentFilter, deploymentFilter, statusFilter, sortField, sortDir])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  useEffect(() => {
    setPage(1)
  }, [search, environmentFilter, deploymentFilter, statusFilter, sortField, sortDir])

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              New infrastructure
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p style={{ color: 'var(--color-danger, #dc2626)' }}>Failed to load BYOL infrastructure: {error}</p>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <FilterBar
            search={{ value: search, onChange: setSearch, placeholder: 'Search infrastructure…' }}
            filters={filters}
          />
          <SortSelect
            options={sortOptions}
            value={sortField}
            direction={sortDir}
            onChange={(field, dir) => {
              setSortField(field)
              setSortDir(dir)
            }}
          />
        </div>

        <DataTable
          columns={columns}
          data={pageRows}
          rowKey={(row) => row.id}
          isLoading={isLoading}
          emptyState={{
            title: 'No BYOL infrastructure yet',
            description: 'Create a BYOL deployment to manage its topology and lifecycle here.',
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
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit "${editing.name}"` : 'New BYOL infrastructure'}
        description="Define the deployment topology for a Bring-Your-Own-License Splunk environment."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Create infrastructure'}
        isSubmitting={submitting}
        submitDisabled={!form.name.trim()}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input label="Name" value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. Production cluster" fullWidth autoFocus />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Select label="Deployment type" value={form.deploymentType} onChange={(value) => setField('deploymentType', value)} options={deploymentTypes} />
            <Select label="Environment" value={form.environmentType} onChange={(value) => setField('environmentType', value)} options={environmentOptions} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: showRegion ? '1fr 1fr' : '1fr', gap: 12 }}>
            <Select
              label="Provider"
              value={form.providerId}
              onChange={(value) => setField('providerId', value)}
              options={providerOptions}
            />
            {showRegion ? (
              <Select
                label="Region"
                value={form.region}
                onChange={(value) => setField('region', value)}
                options={regionOptions}
              />
            ) : null}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="Indexers" type="number" value={form.indexerCount} onChange={(e) => setField('indexerCount', e.target.value)} fullWidth />
            <Input label="Search heads" type="number" value={form.searchHeadCount} onChange={(e) => setField('searchHeadCount', e.target.value)} fullWidth />
          </div>
        </div>
      </FormDialog>
    </Card>
  )
}

export default ByolInfrastructureManager
