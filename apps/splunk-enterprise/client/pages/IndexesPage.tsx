import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import { useAppContext } from '@veltrixsecops/app-sdk/hooks'
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

interface EnvironmentTag {
  indexId: string
  tagId: string
  tag: { id: string; name: string }
}

interface IndexConfig {
  id: string
  name: string
  deployState?: string
  maxDataSizeMB?: number
  frozenTimeDays?: number
  updatedAt?: string
  environments?: EnvironmentTag[]
}

const DEPLOY_STATE_VARIANT: Record<string, 'success' | 'warning' | 'default'> = {
  deployed: 'success',
  'pending approval': 'warning',
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

/**
 * Lists the customer's Splunk index configurations from the app API.
 * Authoring/editing happens in the platform's Configuration Canvas.
 */
export default function IndexesPage() {
  const { appId } = useAppContext()
  const [configs, setConfigs] = useState<IndexConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Search / filter / sort / pagination — the page owns the list state,
  // DataTable just renders whatever page of rows results.
  const [search, setSearch] = useState('')
  const [environmentFilter, setEnvironmentFilter] = useState<string | null>(null)
  const [deployStateFilter, setDeployStateFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const loadIndexes = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch('/api/apps/splunk-enterprise/indexes')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: IndexConfig[]) => setConfigs(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void loadIndexes()
  }, [loadIndexes])

  const columns: DataTableColumn<IndexConfig>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
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
      key: 'maxDataSizeMB',
      header: 'Max size (MB)',
      align: 'right',
      render: (row) => (row.maxDataSizeMB != null ? row.maxDataSizeMB.toLocaleString() : '—'),
    },
    {
      key: 'frozenTimeDays',
      header: 'Frozen after (days)',
      align: 'right',
      render: (row) => row.frozenTimeDays ?? '—',
    },
    {
      key: 'deployState',
      header: 'Status',
      render: (row) => (
        <Badge variant={row.deployState ? DEPLOY_STATE_VARIANT[row.deployState] ?? 'default' : 'default'}>
          {row.deployState ?? 'unknown'}
        </Badge>
      ),
    },
    { key: 'updatedAt', header: 'Updated', render: (row) => formatDate(row.updatedAt) },
  ]

  // Toolbar filter/sort option lists, derived from the fetched configs since
  // this page has no separate environments/deploy-state reference list.
  const environmentFilterOptions = useMemo(() => {
    const seen = new Map<string, string>()
    configs.forEach((c) => c.environments?.forEach((e) => seen.set(e.tag.id, e.tag.name)))
    return Array.from(seen, ([value, label]) => ({ value, label }))
  }, [configs])

  const deployStateFilterOptions = useMemo(() => {
    const seen = new Set<string>()
    configs.forEach((c) => seen.add(c.deployState ?? 'unknown'))
    return Array.from(seen, (value) => ({ value, label: value }))
  }, [configs])

  const sortOptions: SortOption[] = [
    { value: 'name', label: 'Name' },
    { value: 'maxDataSizeMB', label: 'Max size (MB)' },
    { value: 'frozenTimeDays', label: 'Frozen after (days)' },
    { value: 'deployState', label: 'Status' },
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
      key: 'deployState',
      label: 'Status',
      options: deployStateFilterOptions,
      value: deployStateFilter,
      onChange: setDeployStateFilter,
    },
  ]

  // search -> filter -> sort, then slice to the current page.
  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = configs.filter((row) => {
      if (term && !(row.name ?? '').toLowerCase().includes(term)) return false
      if (environmentFilter && !row.environments?.some((e) => e.tag.id === environmentFilter)) return false
      if (deployStateFilter && (row.deployState ?? 'unknown') !== deployStateFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortField) {
        case 'maxDataSizeMB':
          return ((a.maxDataSizeMB ?? 0) - (b.maxDataSizeMB ?? 0)) * dir
        case 'frozenTimeDays':
          return ((a.frozenTimeDays ?? 0) - (b.frozenTimeDays ?? 0)) * dir
        case 'deployState':
          return (a.deployState ?? '').localeCompare(b.deployState ?? '') * dir
        case 'updatedAt':
          return (new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime()) * dir
        case 'name':
        default:
          return (a.name ?? '').localeCompare(b.name ?? '') * dir
      }
    })
  }, [configs, search, environmentFilter, deployStateFilter, sortField, sortDir])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  // Any change to search/filters/sort invalidates the current page.
  useEffect(() => {
    setPage(1)
  }, [search, environmentFilter, deployStateFilter, sortField, sortDir])

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void loadIndexes()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                window.location.href = `/apps/${appId}/config/indexes`
              }}
            >
              Open in Configuration Canvas
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Splunk Index Configurations</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load index configurations: {error}</p>
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
                search={{ value: search, onChange: setSearch, placeholder: 'Search indexes…' }}
                filters={filters}
                onClearAll={() => {
                  setSearch('')
                  setEnvironmentFilter(null)
                  setDeployStateFilter(null)
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
                title: 'No index configurations yet',
                description: 'Create one from the Configuration Canvas.',
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
