import React, { useCallback, useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  DataTable,
  type DataTableColumn,
} from '@veltrixsecops/app-sdk/ui'

interface EnvironmentTag {
  tagId: string
  tag: { id: string; name: string }
}

interface IndexDefaultConfig {
  id: string
  name: string
  retentionPeriod?: number
  searchablePeriod?: number
  frozenTimePeriod?: number
  maxEventSize?: number
  enableCompression?: boolean
  enableTsidx?: boolean
  requireApproval?: boolean
  updatedAt?: string
  environments?: EnvironmentTag[]
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

/**
 * Lists the customer's default index configurations — the per-environment
 * templates that seed new index configs (retention, sizing, compression,
 * approval policy). Read-only surface over GET /indexes/defaults.
 */
export default function IndexDefaultsPage() {
  const [configs, setConfigs] = useState<IndexDefaultConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadDefaults = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch('/api/apps/splunk-enterprise/indexes/defaults')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: IndexDefaultConfig[]) => setConfigs(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void loadDefaults()
  }, [loadDefaults])

  const columns: DataTableColumn<IndexDefaultConfig>[] = [
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
      key: 'retentionPeriod',
      header: 'Retention (days)',
      align: 'right',
      render: (row) => row.retentionPeriod ?? '—',
    },
    {
      key: 'frozenTimePeriod',
      header: 'Frozen after (days)',
      align: 'right',
      render: (row) => row.frozenTimePeriod ?? '—',
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
  ]

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <Button variant="secondary" size="sm" onClick={() => void loadDefaults()} isLoading={isLoading}>
            Refresh
          </Button>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Index Default Configurations</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load index default configurations: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={configs}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No index defaults yet',
              description: 'Default index templates seed new index configurations per environment.',
            }}
          />
        )}
      </CardBody>
    </Card>
  )
}
