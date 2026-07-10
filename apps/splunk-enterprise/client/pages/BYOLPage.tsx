import React, { useCallback, useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import { Card, CardHeader, CardBody, Button, Badge, DataTable, type DataTableColumn } from '@veltrixsecops/app-sdk/ui'

interface ByolInfrastructure {
  id: string
  name: string
  deploymentType?: string
  environmentType?: string
  indexerCount?: number
  searchHeadCount?: number
  status?: string
  hosting_type?: string
  updatedAt?: string
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  active: 'success',
  running: 'success',
  provisioning: 'warning',
  failed: 'danger',
  error: 'danger',
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

/**
 * Lists the customer's BYOL Splunk infrastructure from the app API.
 */
export default function BYOLPage() {
  const [infrastructure, setInfrastructure] = useState<ByolInfrastructure[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadInfrastructure = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch('/api/apps/splunk-enterprise/byol')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: ByolInfrastructure[]) => setInfrastructure(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void loadInfrastructure()
  }, [loadInfrastructure])

  const columns: DataTableColumn<ByolInfrastructure>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'deploymentType', header: 'Deployment', render: (row) => row.deploymentType ?? '—' },
    { key: 'environmentType', header: 'Environment', render: (row) => row.environmentType ?? '—' },
    { key: 'hosting_type', header: 'Hosting', render: (row) => row.hosting_type ?? '—' },
    {
      key: 'indexerCount',
      header: 'Indexers',
      align: 'right',
      render: (row) => row.indexerCount ?? '—',
    },
    {
      key: 'searchHeadCount',
      header: 'Search heads',
      align: 'right',
      render: (row) => row.searchHeadCount ?? '—',
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge variant={row.status ? STATUS_VARIANT[row.status] ?? 'default' : 'default'}>{row.status ?? 'unknown'}</Badge>
      ),
    },
    { key: 'updatedAt', header: 'Updated', render: (row) => formatDate(row.updatedAt) },
  ]

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <Button variant="secondary" size="sm" onClick={() => void loadInfrastructure()} isLoading={isLoading}>
            Refresh
          </Button>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>BYOL Splunk Infrastructure</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load BYOL infrastructure: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={infrastructure}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No BYOL infrastructure provisioned yet',
              description: 'Provision infrastructure from the platform to see it here.',
            }}
          />
        )}
      </CardBody>
    </Card>
  )
}
