import React, { useCallback, useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import { useAppContext } from '@veltrixsecops/app-sdk/hooks'
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
  roleId: string
  tagId: string
  tag: { id: string; name: string }
}

interface RoleConfig {
  id: string
  name: string
  description?: string | null
  permissions?: string[]
  deployState?: string
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
 * Lists the customer's Splunk role configurations from the app API.
 * Authoring/editing happens in the platform's Configuration Canvas.
 */
export default function RolesPage() {
  const { appId } = useAppContext()
  const [configs, setConfigs] = useState<RoleConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadRoles = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch('/api/apps/splunk-enterprise/roles')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: RoleConfig[]) => setConfigs(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void loadRoles()
  }, [loadRoles])

  const columns: DataTableColumn<RoleConfig>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'description', header: 'Description', render: (row) => row.description || '—' },
    {
      key: 'permissions',
      header: 'Capabilities',
      render: (row) =>
        row.permissions && row.permissions.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {row.permissions.map((permission) => (
              <Badge key={permission} variant="info" size="sm">
                {permission}
              </Badge>
            ))}
          </div>
        ) : (
          '—'
        ),
    },
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

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void loadRoles()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                window.location.href = `/apps/${appId}/config/roles`
              }}
            >
              Open in Configuration Canvas
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Splunk Role Configurations</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load role configurations: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={configs}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No role configurations yet',
              description: 'Create one from the Configuration Canvas.',
            }}
          />
        )}
      </CardBody>
    </Card>
  )
}
