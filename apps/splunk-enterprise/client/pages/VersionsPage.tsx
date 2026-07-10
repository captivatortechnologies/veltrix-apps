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
          <DataTable
            columns={columns}
            data={versions}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No versions tracked',
              description: 'Splunk release lines are seeded when the app is installed.',
            }}
          />
        )}
      </CardBody>
    </Card>
  )
}
