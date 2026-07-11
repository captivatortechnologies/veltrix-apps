import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  DataTable,
  FilterBar,
  SortSelect,
  Pagination,
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
} from '@veltrixsecops/app-sdk/ui'

interface SplunkVersion {
  id: string
  version: string
  releaseDate?: string
  downloadUrl?: string | null
  releaseNotes?: string | null
  isActive?: boolean
  isLatest?: boolean
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

/**
 * Lists the Splunk Enterprise release lines the app tracks (seeded by
 * hooks/onInstall.ts) for BYOL upgrade planning. Read-only surface over
 * GET /versions.
 */
export default function VersionsPage() {
  const [versions, setVersions] = useState<SplunkVersion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Search / filter / sort / pagination — the page owns the list state,
  // DataTable just renders whatever page of rows results.
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [latestFilter, setLatestFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('version')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const loadVersions = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch('/api/apps/splunk-enterprise/versions')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: SplunkVersion[]) => setVersions(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void loadVersions()
  }, [loadVersions])

  const columns: DataTableColumn<SplunkVersion>[] = [
    { key: 'version', header: 'Version', render: (row) => <strong>{row.version}</strong> },
    { key: 'releaseDate', header: 'Released', render: (row) => formatDate(row.releaseDate) },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {row.isLatest ? <Badge variant="success">latest</Badge> : null}
          <Badge variant={row.isActive ? 'secondary' : 'default'} size="sm">
            {row.isActive ? 'active' : 'inactive'}
          </Badge>
        </div>
      ),
    },
    {
      key: 'downloadUrl',
      header: 'Download',
      render: (row) =>
        row.downloadUrl ? (
          <a href={row.downloadUrl} target="_blank" rel="noreferrer noopener">
            link
          </a>
        ) : (
          '—'
        ),
    },
  ]

  // Toolbar filter/sort option lists.
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

  // search -> filter -> sort, then slice to the current page.
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

  // Any change to search/filters/sort invalidates the current page.
  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, latestFilter, sortField, sortDir])

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <Button variant="secondary" size="sm" onClick={() => void loadVersions()} isLoading={isLoading}>
            Refresh
          </Button>
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
                description: 'Splunk release lines are seeded when the app is installed.',
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
    </Card>
  )
}
