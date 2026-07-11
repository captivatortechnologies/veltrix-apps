import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Checkbox,
  Input,
  Textarea,
  FormDialog,
  DataTable,
  FilterBar,
  SortSelect,
  Pagination,
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
} from '@veltrixsecops/app-sdk/ui'

interface EnvironmentTag {
  tagId: string
  tag: { id: string; name: string }
}

interface RoleDefaultConfig {
  id: string
  name: string
  description?: string | null
  defaultPermissions?: string[]
  requireApproval?: boolean
  updatedAt?: string
  environments?: EnvironmentTag[]
}

interface FormState {
  name: string
  description: string
  defaultPermissions: string
  requireApproval: boolean
}

const BLANK_FORM: FormState = {
  name: '',
  description: '',
  defaultPermissions: '',
  requireApproval: true,
}

const API = '/api/apps/splunk-enterprise/roles/defaults'

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

function toForm(row: RoleDefaultConfig): FormState {
  return {
    name: row.name ?? '',
    description: row.description ?? '',
    defaultPermissions: (row.defaultPermissions ?? []).join(', '),
    requireApproval: row.requireApproval ?? true,
  }
}

async function errorText(res: Response): Promise<string> {
  return res
    .json()
    .then((b: { error?: string }) => b?.error || `HTTP ${res.status}`)
    .catch(() => `HTTP ${res.status}`)
}

/**
 * Manage the customer's default role configurations — the per-environment
 * templates that seed new role configs (default permissions, approval policy).
 * Full CRUD over the app's /roles/defaults routes.
 */
export default function RoleDefaultsPage() {
  const [configs, setConfigs] = useState<RoleDefaultConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Search / filter / sort / pagination — the page owns the list state,
  // DataTable just renders whatever page of rows results.
  const [search, setSearch] = useState('')
  const [environmentFilter, setEnvironmentFilter] = useState<string | null>(null)
  const [approvalFilter, setApprovalFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<RoleDefaultConfig | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch(API)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: RoleDefaultConfig[]) => setConfigs(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(BLANK_FORM)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: RoleDefaultConfig) => {
    setEditing(row)
    setForm(toForm(row))
    setFormError(null)
    setDialogOpen(true)
  }

  // Memoized so FormDialog's focus effect doesn't steal focus from fields on each keystroke.
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
    setSubmitting(true)
    setFormError(null)
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      defaultPermissions: form.defaultPermissions
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      requireApproval: form.requireApproval,
    }
    try {
      const res = await authFetch(editing ? `${API}/${editing.id}` : API, {
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

  const handleDelete = async (row: RoleDefaultConfig) => {
    if (!window.confirm(`Delete role default "${row.name}"? This cannot be undone.`)) return
    try {
      const res = await authFetch(`${API}/${row.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res))
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const columns: DataTableColumn<RoleDefaultConfig>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'description', header: 'Description', render: (row) => row.description || '—' },
    {
      key: 'environments',
      header: 'Environments',
      render: (row) =>
        row.environments && row.environments.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {row.environments.map((env) => (
              <Badge key={env.tagId} variant="secondary" size="sm">
                {env.tag.name}
              </Badge>
            ))}
          </div>
        ) : (
          '—'
        ),
    },
    {
      key: 'defaultPermissions',
      header: 'Default capabilities',
      align: 'right',
      render: (row) => (row.defaultPermissions ? row.defaultPermissions.length : 0),
    },
    {
      key: 'requireApproval',
      header: 'Approval',
      render: (row) => (
        <Badge variant={row.requireApproval ? 'warning' : 'default'}>
          {row.requireApproval ? 'required' : 'not required'}
        </Badge>
      ),
    },
    { key: 'updatedAt', header: 'Updated', render: (row) => formatDate(row.updatedAt) },
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
            Delete
          </Button>
        </div>
      ),
    },
  ]

  // Toolbar filter/sort option lists, derived from the fetched configs since
  // this page has no separate environments reference list.
  const environmentFilterOptions = useMemo(() => {
    const seen = new Map<string, string>()
    configs.forEach((c) => c.environments?.forEach((e) => seen.set(e.tag.id, e.tag.name)))
    return Array.from(seen, ([value, label]) => ({ value, label }))
  }, [configs])

  const approvalFilterOptions = [
    { value: 'required', label: 'Required' },
    { value: 'not-required', label: 'Not required' },
  ]

  const sortOptions: SortOption[] = [
    { value: 'name', label: 'Name' },
    { value: 'updatedAt', label: 'Updated' },
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
      key: 'approval',
      label: 'Approval',
      options: approvalFilterOptions,
      value: approvalFilter,
      onChange: setApprovalFilter,
    },
  ]

  // search -> filter -> sort, then slice to the current page.
  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = configs.filter((row) => {
      if (term) {
        const haystack = `${row.name ?? ''} ${row.description ?? ''}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (environmentFilter && !row.environments?.some((e) => e.tag.id === environmentFilter)) return false
      if (approvalFilter && (row.requireApproval ? 'required' : 'not-required') !== approvalFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortField) {
        case 'updatedAt':
          return (new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime()) * dir
        case 'name':
        default:
          return (a.name ?? '').localeCompare(b.name ?? '') * dir
      }
    })
  }, [configs, search, environmentFilter, approvalFilter, sortField, sortDir])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  // Any change to search/filters/sort invalidates the current page.
  useEffect(() => {
    setPage(1)
  }, [search, environmentFilter, approvalFilter, sortField, sortDir])

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              New default
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Role Default Configurations</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load role default configurations: {error}</p>
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
                search={{ value: search, onChange: setSearch, placeholder: 'Search role defaults…' }}
                filters={filters}
                onClearAll={() => {
                  setSearch('')
                  setEnvironmentFilter(null)
                  setApprovalFilter(null)
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
                title: 'No role defaults yet',
                description: 'Create a default template that seeds new role configurations per environment.',
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
        title={editing ? `Edit "${editing.name}"` : 'New role default'}
        description="Default settings applied when seeding new role configurations."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Create default'}
        isSubmitting={submitting}
        submitDisabled={!form.name.trim()}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="e.g. Standard analyst"
            fullWidth
            autoFocus
          />
          <Textarea
            label="Description"
            value={form.description}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="What roles seeded from this default are for"
            rows={2}
            fullWidth
          />
          <Input
            label="Default capabilities"
            value={form.defaultPermissions}
            onChange={(e) => setField('defaultPermissions', e.target.value)}
            placeholder="comma-separated, e.g. search, rtsearch, schedule_search"
            helperText="Splunk capabilities granted to roles seeded from this default."
            fullWidth
          />
          <Checkbox
            label="Require approval before deploy"
            checked={form.requireApproval}
            onChange={(e) => setField('requireApproval', e.target.checked)}
          />
        </div>
      </FormDialog>
    </Card>
  )
}
