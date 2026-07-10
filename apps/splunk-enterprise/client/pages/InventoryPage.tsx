import React, { useCallback, useEffect, useState } from 'react'
import { listInventory, type InventoryItem } from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  DataTable,
  type DataTableColumn,
} from '@veltrixsecops/app-sdk/ui'

// The Splunk component types this app deploys configuration to. Inventory is a
// shared, cross-app surface (every server/domain/IP the customer registers), so
// this page focuses on the targets Splunk Enterprise cares about while still
// showing anything untyped.
const SPLUNK_TYPES = new Set([
  'indexer',
  'search-head',
  'cluster-manager',
  'heavy-forwarder',
  'universal-forwarder',
  'deployment-server',
  'deployer',
  'license-server',
  'sc4s',
])

function isSplunkTarget(item: InventoryItem): boolean {
  if (!item.type || item.type.length === 0) return true
  return item.type.some((t) => SPLUNK_TYPES.has(t))
}

function commaList(values?: string[]): string {
  return values && values.length > 0 ? values.join(', ') : '—'
}

/**
 * Servers — the Splunk deployment targets (indexers, search heads, cluster
 * managers, forwarders …) this app deploys index/role/HEC configuration to.
 * Backed by the platform Inventory (GET /api/components); authoring/adding a
 * server happens through the in-context "Add connection" flow when configuring.
 */
export default function InventoryPage() {
  const [servers, setServers] = useState<InventoryItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return listInventory()
      .then((data) => setServers(data.filter(isSplunkTarget)))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const columns: DataTableColumn<InventoryItem>[] = [
    { key: 'hostname', header: 'Hostname', render: (row) => <strong>{row.hostname}</strong> },
    {
      key: 'type',
      header: 'Type',
      render: (row) =>
        row.type && row.type.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {row.type.map((t) => (
              <Badge key={t} variant="secondary" size="sm">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          '—'
        ),
    },
    { key: 'port', header: 'Port', align: 'right', render: (row) => row.port ?? '—' },
    { key: 'domains', header: 'Domains', render: (row) => commaList(row.domains) },
    { key: 'ipRanges', header: 'IP ranges', render: (row) => commaList(row.ipRanges) },
    {
      key: 'tags',
      header: 'Environments',
      render: (row) =>
        row.tags && row.tags.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {row.tags.map((tag) => (
              <Badge key={tag.id} variant="secondary" size="sm">
                {tag.name}
              </Badge>
            ))}
          </div>
        ) : (
          '—'
        ),
    },
  ]

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
            Refresh
          </Button>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Servers</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load servers: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={servers}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No servers registered yet',
              description:
                'Add a Splunk server (indexer, search head, cluster manager, forwarder …) from the ' +
                'Setup Guide or the in-context "Add connection" flow when configuring.',
            }}
          />
        )}
      </CardBody>
    </Card>
  )
}
