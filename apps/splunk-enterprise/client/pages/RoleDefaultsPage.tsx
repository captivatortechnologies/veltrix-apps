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

interface RoleDefaultConfig {
  id: string
  name: string
  description?: string
  defaultPermissions?: string[]
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
 * Lists the customer's default role configurations — the per-environment
 * templates that seed new role configs (default permissions, approval policy).
 * Read-only surface over GET /roles/defaults.
 */
export default function RoleDefaultsPage() {
  const [configs, setConfigs] = useState<RoleDefaultConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadDefaults = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch('/api/apps/splunk-enterprise/roles/defaults')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: RoleDefaultConfig[]) => setConfigs(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void loadDefaults()
  }, [loadDefaults])

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
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Role Default Configurations</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load role default configurations: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={configs}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No role defaults yet',
              description: 'Default role templates seed new role configurations per environment.',
            }}
          />
        )}
      </CardBody>
    </Card>
  )
}
