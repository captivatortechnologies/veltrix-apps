import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
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
} from '@veltrixsecops/app-sdk/ui'

interface UpgradeOperation {
  id: string
  infrastructureId: string
  infraName: string
  previousVersion: string
  targetVersion: string
  status: string
  scheduledFor?: string | null
  maintenanceWindow?: string | null
  createdAt?: string
}

interface Infra {
  id: string
  name: string
}

interface Version {
  id: string
  version: string
  isLatest?: boolean
}

interface FormState {
  infrastructureId: string
  fromVersionId: string
  toVersionId: string
  scheduledFor: string
  maintenanceWindow: string
}

const BLANK_FORM: FormState = {
  infrastructureId: '',
  fromVersionId: '',
  toVersionId: '',
  scheduledFor: '',
  maintenanceWindow: '',
}

const API = '/api/apps/splunk-enterprise/upgrades'

const STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CANCELED', label: 'Canceled' },
]

function statusVariant(status: string): 'default' | 'primary' | 'warning' | 'success' | 'danger' {
  switch (status) {
    case 'COMPLETED':
      return 'success'
    case 'IN_PROGRESS':
      return 'primary'
    case 'FAILED':
      return 'danger'
    case 'PENDING':
      return 'warning'
    default:
      return 'default'
  }
}

function formatDate(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json()
    return body?.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

/**
 * Plan and track Splunk version upgrades of BYOL infrastructure. Lists upgrade
 * operations (from → to version, status, schedule) and lets an operator plan a
 * new one. Full CRUD over the app's /upgrades routes; rendered with the
 * platform design-system components from @veltrixsecops/app-sdk/ui.
 */
export default function UpgradesPage() {
  const [operations, setOperations] = useState<UpgradeOperation[]>([])
  const [infras, setInfras] = useState<Infra[]>([])
  const [versions, setVersions] = useState<Version[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('createdAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return Promise.all([
      authFetch(API).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      authFetch('/api/apps/splunk-enterprise/byol').then((r) => (r.ok ? r.json() : [])),
      authFetch('/api/apps/splunk-enterprise/versions').then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([ops, byol, vers]: [UpgradeOperation[], Infra[], Version[]]) => {
        setOperations(ops)
        setInfras(byol)
        setVersions(vers)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setForm(BLANK_FORM)
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
    if (!form.infrastructureId || !form.fromVersionId || !form.toVersionId) {
      setFormError('Infrastructure, current version and target version are required')
      return
    }
    if (form.fromVersionId === form.toVersionId) {
      setFormError('Target version must differ from the current version')
      return
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await authFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          infrastructureId: form.infrastructureId,
          fromVersionId: form.fromVersionId,
          toVersionId: form.toVersionId,
          scheduledFor: form.scheduledFor || null,
          maintenanceWindow: form.maintenanceWindow || null,
        }),
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

  const transition = async (row: UpgradeOperation, status: string) => {
    try {
      const res = await authFetch(`${API}/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res))
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const infraOptions = useMemo(
    () => [{ value: '', label: 'Select infrastructure…' }, ...infras.map((i) => ({ value: i.id, label: i.name }))],
    [infras],
  )
  const versionOptions = useMemo(
    () => [
      { value: '', label: 'Select version…' },
      ...versions.map((v) => ({ value: v.id, label: v.isLatest ? `${v.version} (latest)` : v.version })),
    ],
    [versions],
  )

  const columns: DataTableColumn<UpgradeOperation>[] = [
    { key: 'infraName', header: 'Infrastructure', render: (row) => <strong>{row.infraName}</strong> },
    {
      key: 'upgrade',
      header: 'Upgrade',
      render: (row) => (
        <span>
          {row.previousVersion} <span aria-hidden>→</span> {row.targetVersion}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge variant={statusVariant(row.status)}>{row.status.replace('_', ' ').toLowerCase()}</Badge>,
    },
    { key: 'scheduledFor', header: 'Scheduled', render: (row) => formatDate(row.scheduledFor) },
    { key: 'maintenanceWindow', header: 'Window', render: (row) => row.maintenanceWindow || '—' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        const terminal = ['COMPLETED', 'FAILED', 'CANCELED'].includes(row.status)
        if (terminal) return <span style={{ color: 'var(--vx-text-muted, #888)' }}>—</span>
        return (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => void transition(row, 'COMPLETED')}>
              Mark complete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void transition(row, 'CANCELED')}>
              Cancel
            </Button>
          </div>
        )
      },
    },
  ]

  const sortOptions: SortOption[] = [
    { value: 'createdAt', label: 'Created' },
    { value: 'scheduledFor', label: 'Scheduled' },
    { value: 'infraName', label: 'Infrastructure' },
  ]
  const filters: FilterDefinition[] = [
    {
      key: 'status',
      label: 'Status',
      options: STATUS_OPTIONS,
      value: statusFilter,
      onChange: setStatusFilter,
      alwaysVisible: true,
    },
  ]

  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = operations.filter((row) => {
      if (term && !(row.infraName ?? '').toLowerCase().includes(term)) return false
      if (statusFilter && row.status !== statusFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortField) {
        case 'scheduledFor':
          return (new Date(a.scheduledFor ?? 0).getTime() - new Date(b.scheduledFor ?? 0).getTime()) * dir
        case 'infraName':
          return (a.infraName ?? '').localeCompare(b.infraName ?? '') * dir
        case 'createdAt':
        default:
          return (new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()) * dir
      }
    })
  }, [operations, search, statusFilter, sortField, sortDir])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, sortField, sortDir])

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate} disabled={infras.length === 0}>
              Plan upgrade
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Splunk Upgrades</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load upgrade operations: {error}</p>
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
                search={{ value: search, onChange: setSearch, placeholder: 'Search by infrastructure…' }}
                filters={filters}
                onClearAll={() => {
                  setSearch('')
                  setStatusFilter(null)
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
                title:
                  infras.length === 0
                    ? 'Add BYOL infrastructure first, then plan an upgrade.'
                    : 'No upgrade operations yet. Plan one to get started.',
              }}
            />
            <Pagination
              page={page}
              pageSize={pageSize}
              totalItems={filteredSorted.length}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              pageSizeOptions={[10, 25, 50]}
            />
          </>
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title="Plan a Splunk upgrade"
        description="Schedule an upgrade of a BYOL infrastructure from its current Splunk version to a target version."
        onSubmit={handleSubmit}
        submitText="Create upgrade"
        isSubmitting={submitting}
        submitDisabled={!form.infrastructureId || !form.fromVersionId || !form.toVersionId}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Select
            label="Infrastructure"
            value={form.infrastructureId}
            onChange={(value) => setField('infrastructureId', value)}
            options={infraOptions}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Select
              label="Current version"
              value={form.fromVersionId}
              onChange={(value) => setField('fromVersionId', value)}
              options={versionOptions}
            />
            <Select
              label="Target version"
              value={form.toVersionId}
              onChange={(value) => setField('toVersionId', value)}
              options={versionOptions}
            />
          </div>
          <Input
            label="Scheduled for"
            type="datetime-local"
            value={form.scheduledFor}
            onChange={(e) => setField('scheduledFor', e.target.value)}
            fullWidth
          />
          <Input
            label="Maintenance window"
            value={form.maintenanceWindow}
            onChange={(e) => setField('maintenanceWindow', e.target.value)}
            placeholder="e.g. Sat 02:00–04:00 UTC"
            fullWidth
          />
        </div>
      </FormDialog>
    </Card>
  )
}
