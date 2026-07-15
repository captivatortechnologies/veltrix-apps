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
  Textarea,
  Checkbox,
  FormDialog,
  DataTable,
  FilterBar,
  SortSelect,
  Pagination,
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
} from '@veltrixsecops/app-sdk/ui'

const API = '/api/apps/splunk-enterprise/versions'

interface SplunkVersion {
  id: string
  version: string
  releaseDate?: string
  downloadUrl?: string | null
  releaseNotes?: string | null
  isActive?: boolean
  isLatest?: boolean
  // A system version (seeded / system upload) is shown to every tenant and is
  // read-only here; only the owning company's own versions are editable.
  system?: boolean
}

type Source = 'url' | 'upload'

interface FormState {
  version: string
  releaseDate: string
  source: Source
  downloadUrl: string
  releaseNotes: string
  isLatest: boolean
  isActive: boolean
}

const BLANK_FORM: FormState = {
  version: '',
  releaseDate: '',
  source: 'url',
  downloadUrl: '',
  releaseNotes: '',
  isLatest: false,
  isActive: true,
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

/** An installer stored in S3 is referenced as `s3://…`; http(s) URLs are direct. */
function isUploadedPackage(url?: string | null): boolean {
  return typeof url === 'string' && url.startsWith('s3://')
}

/** YYYY-MM-DD for a date input from an ISO/date string. */
function toDateInput(value?: string): string {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json()
    return typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

/**
 * Splunk Enterprise version catalog for BYOL upgrade planning. Seeded release
 * lines (hooks/onInstall.ts) plus operator-added versions — register a release
 * and attach the installer by download URL or by uploading the package to S3.
 */
export default function VersionsPage() {
  const [versions, setVersions] = useState<SplunkVersion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [uploadsEnabled, setUploadsEnabled] = useState(false)

  // List state.
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [latestFilter, setLatestFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('version')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  // Dialog state.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<SplunkVersion | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadVersions = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch(API)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: SplunkVersion[]) => setVersions(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void loadVersions()
    void authFetch(`${API}/uploads-enabled`)
      .then((res) => (res.ok ? res.json() : { enabled: false }))
      .then((d: { enabled?: boolean }) => setUploadsEnabled(Boolean(d?.enabled)))
      .catch(() => setUploadsEnabled(false))
  }, [loadVersions])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const openCreate = () => {
    setEditing(null)
    setForm(BLANK_FORM)
    setFile(null)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: SplunkVersion) => {
    const uploaded = isUploadedPackage(row.downloadUrl)
    setEditing(row)
    setForm({
      version: row.version,
      releaseDate: toDateInput(row.releaseDate),
      source: uploaded ? 'upload' : 'url',
      downloadUrl: uploaded ? '' : row.downloadUrl ?? '',
      releaseNotes: row.releaseNotes ?? '',
      isLatest: Boolean(row.isLatest),
      isActive: row.isActive ?? true,
    })
    setFile(null)
    setFormError(null)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    if (submitting) return
    setDialogOpen(false)
  }

  /** Upload a file to S3 via a presigned PUT for the given version id. */
  async function uploadPackage(versionId: string, pkg: File): Promise<void> {
    const contentType = pkg.type || 'application/octet-stream'
    const res = await authFetch(`${API}/${versionId}/package-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: pkg.name, contentType }),
    })
    if (!res.ok) throw new Error(await errorText(res))
    const { uploadUrl } = (await res.json()) as { uploadUrl: string }
    // Direct browser → S3 transfer; the presigned URL carries its own auth.
    const put = await fetch(uploadUrl, { method: 'PUT', body: pkg, headers: { 'Content-Type': contentType } })
    if (!put.ok) throw new Error(`Upload to storage failed (HTTP ${put.status})`)
  }

  async function handleSubmit() {
    setSubmitting(true)
    setFormError(null)
    try {
      const uploadingNew = form.source === 'upload' && file !== null
      const keepingExisting = Boolean(editing && isUploadedPackage(editing.downloadUrl))

      if (form.source === 'upload' && !uploadingNew && !keepingExisting) {
        throw new Error('Choose a package file to upload')
      }

      const payload = {
        version: form.version.trim(),
        releaseDate: form.releaseDate || undefined,
        downloadUrl: form.source === 'url' ? form.downloadUrl.trim() : undefined,
        releaseNotes: form.releaseNotes.trim() || undefined,
        isLatest: form.isLatest,
        isActive: form.isActive,
      }

      let versionId = editing?.id ?? ''
      if (editing) {
        const res = await authFetch(`${API}/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(await errorText(res))
      } else {
        const res = await authFetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(await errorText(res))
        versionId = ((await res.json()) as SplunkVersion).id
      }

      if (uploadingNew && file && versionId) {
        await uploadPackage(versionId, file)
      }

      setDialogOpen(false)
      await loadVersions()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(row: SplunkVersion) {
    if (!window.confirm(`Delete version ${row.version}? This also removes any uploaded package.`)) return
    setDeletingId(row.id)
    try {
      const res = await authFetch(`${API}/${row.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res))
      await loadVersions()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }

  async function handleDownload(row: SplunkVersion) {
    try {
      const res = await authFetch(`${API}/${row.id}/download-url`)
      if (!res.ok) throw new Error(await errorText(res))
      const { url } = (await res.json()) as { url: string }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const columns: DataTableColumn<SplunkVersion>[] = [
    { key: 'version', header: 'Version', render: (row) => <strong>{row.version}</strong> },
    { key: 'releaseDate', header: 'Released', render: (row) => formatDate(row.releaseDate) },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {row.isLatest ? <Badge variant="success">latest</Badge> : null}
          {row.system ? <Badge variant="default" size="sm">system</Badge> : null}
          <Badge variant={row.isActive ? 'secondary' : 'default'} size="sm">
            {row.isActive ? 'active' : 'inactive'}
          </Badge>
        </div>
      ),
    },
    {
      key: 'downloadUrl',
      header: 'Installer',
      render: (row) =>
        row.downloadUrl ? (
          <Button variant="secondary" size="sm" onClick={() => void handleDownload(row)}>
            {isUploadedPackage(row.downloadUrl) ? 'Download package' : 'Download'}
          </Button>
        ) : (
          '—'
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        row.system ? (
          <span style={{ fontSize: 12, color: '#6b7280', display: 'block', textAlign: 'right' }}>
            Managed by Veltrix
          </span>
        ) : (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" size="sm" onClick={() => openEdit(row)}>
              Edit
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void handleDelete(row)}
              isLoading={deletingId === row.id}
            >
              Delete
            </Button>
          </div>
        ),
    },
  ]

  const statusFilterOptions = [
    { value: 'active', label: 'Active' },
    { value: 'inactive', label: 'Inactive' },
  ]
  const latestFilterOptions = [
    { value: 'latest', label: 'Latest' },
    { value: 'not-latest', label: 'Not latest' },
  ]
  const sortOptions: SortOption[] = [
    { value: 'version', label: 'Version' },
    { value: 'releaseDate', label: 'Released' },
  ]
  const filters: FilterDefinition[] = [
    {
      key: 'status',
      label: 'Status',
      options: statusFilterOptions,
      value: statusFilter,
      onChange: setStatusFilter,
      alwaysVisible: true,
    },
    {
      key: 'latest',
      label: 'Latest',
      options: latestFilterOptions,
      value: latestFilter,
      onChange: setLatestFilter,
    },
  ]

  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = versions.filter((row) => {
      if (term && !(row.version ?? '').toLowerCase().includes(term)) return false
      if (statusFilter && (row.isActive ? 'active' : 'inactive') !== statusFilter) return false
      if (latestFilter && (row.isLatest ? 'latest' : 'not-latest') !== latestFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortField) {
        case 'releaseDate':
          return (new Date(a.releaseDate ?? 0).getTime() - new Date(b.releaseDate ?? 0).getTime()) * dir
        case 'version':
        default:
          return (a.version ?? '').localeCompare(b.version ?? '', undefined, { numeric: true }) * dir
      }
    })
  }, [versions, search, statusFilter, latestFilter, sortField, sortDir])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, latestFilter, sortField, sortDir])

  const sourceOptions = [
    { value: 'url', label: 'Download URL' },
    { value: 'upload', label: 'Upload package' },
  ]

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void loadVersions()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              New version
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Splunk Versions</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load Splunk versions: {error}</p>
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
                search={{ value: search, onChange: setSearch, placeholder: 'Search versions…' }}
                filters={filters}
                onClearAll={() => {
                  setSearch('')
                  setStatusFilter(null)
                  setLatestFilter(null)
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
                title: 'No versions tracked',
                description: 'Add a version with “New version”, or reinstall to reseed the release lines.',
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
        title={editing ? `Edit version ${editing.version}` : 'Add Splunk version'}
        description="Register a Splunk release and attach its installer by download URL or by uploading the package."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save' : 'Add version'}
        isSubmitting={submitting}
        submitDisabled={!form.version.trim()}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Version"
              value={form.version}
              onChange={(e) => setField('version', e.target.value)}
              placeholder="e.g. 10.4.2"
              fullWidth
            />
            <Input
              label="Release date"
              type="date"
              value={form.releaseDate}
              onChange={(e) => setField('releaseDate', e.target.value)}
              fullWidth
            />
          </div>

          <Select
            label="Installer source"
            value={form.source}
            onChange={(value) => setField('source', value as Source)}
            options={sourceOptions}
          />

          {form.source === 'url' ? (
            <Input
              label="Download URL"
              value={form.downloadUrl}
              onChange={(e) => setField('downloadUrl', e.target.value)}
              placeholder="https://download.splunk.com/…/splunk-10.4.2-linux-amd64.tgz"
              fullWidth
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Package file</label>
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {editing && isUploadedPackage(editing.downloadUrl) && !file ? (
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  A package is already attached — choose a new file only to replace it.
                </span>
              ) : null}
              {!uploadsEnabled ? (
                <span style={{ fontSize: 12, color: '#b45309' }}>
                  Uploads are not configured for this environment.
                </span>
              ) : null}
            </div>
          )}

          <Textarea
            label="Release notes"
            value={form.releaseNotes}
            onChange={(e) => setField('releaseNotes', e.target.value)}
            fullWidth
            rows={3}
          />

          <div style={{ display: 'flex', gap: 20 }}>
            <Checkbox
              label="Mark as latest"
              checked={form.isLatest}
              onChange={(e) => setField('isLatest', e.target.checked)}
            />
            <Checkbox
              label="Active"
              checked={form.isActive}
              onChange={(e) => setField('isActive', e.target.checked)}
            />
          </div>
        </div>
      </FormDialog>
    </Card>
  )
}
