// =============================================================================
// Inventory — the built-in deployment-target surface every app shares.
//
// "Inventory" is the app-facing name for the platform's components: the servers
// (hostname/port), domains, and IP/CIDR ranges a customer has registered as
// deploy targets. This page lists them and lets an operator add a server, using
// the typed helpers from '@veltrixsecops/app-sdk/client' — no bespoke API
// plumbing required. Compose the body from '@veltrixsecops/app-sdk/ui' so it
// inherits the tenant's theme and your app's branding.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import {
  listInventory,
  addInventoryItem,
  type InventoryItem,
} from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Input,
  FormDialog,
  DataTable,
  type DataTableColumn,
} from '@veltrixsecops/app-sdk/ui'

interface FormState {
  hostname: string
  port: string
  /** Comma-separated DNS names, split into an array on submit. */
  domains: string
  /** Comma-separated IP addresses / CIDR ranges, split into an array on submit. */
  ipRanges: string
}

const BLANK_FORM: FormState = {
  hostname: '',
  port: '',
  domains: '',
  ipRanges: '',
}

/** Split a comma-separated field into a trimmed, non-empty string array. */
function toList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** Render a list of strings as small badges, or an em dash when empty. */
function BadgeList({ values }: { values?: string[] }): React.ReactElement {
  if (!values || values.length === 0) return <>—</>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {values.map((value) => (
        <Badge key={value} variant="secondary" size="sm">
          {value}
        </Badge>
      ))}
    </div>
  )
}

/**
 * Inventory page — lists the customer's deployment targets and adds new servers.
 * Modeled on the platform CRUD pattern: FormDialog + DataTable + the SDK's
 * framework-free inventory helpers.
 */
export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return listInventory()
      .then((data) => setItems(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setForm(BLANK_FORM)
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
    if (!form.hostname.trim()) {
      setFormError('Hostname is required')
      return
    }
    setSubmitting(true)
    setFormError(null)
    try {
      // NOTE: the platform requires a `toolId` on create — the tool these
      // targets belong to. Source it from your app (settings/context) and pass
      // it here; without it the platform rejects the create with a 400.
      await addInventoryItem({
        hostname: form.hostname.trim(),
        port: form.port.trim() || undefined,
        domains: toList(form.domains),
        ipRanges: toList(form.ipRanges),
      })
      setDialogOpen(false)
      await load()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const columns: DataTableColumn<InventoryItem>[] = [
    {
      key: 'hostname',
      header: 'Hostname',
      render: (row) => <strong>{row.hostname}</strong>,
    },
    { key: 'port', header: 'Port', align: 'right', render: (row) => row.port ?? '—' },
    { key: 'domains', header: 'Domains', render: (row) => <BadgeList values={row.domains} /> },
    { key: 'ipRanges', header: 'IP ranges', render: (row) => <BadgeList values={row.ipRanges} /> },
    {
      key: 'tags',
      header: 'Tags',
      render: (row) => <BadgeList values={row.tags?.map((tag) => tag.name)} />,
    },
  ]

  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              Add server
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Inventory</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load inventory: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={items}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No deployment targets yet',
              description:
                'Add a server (hostname/port), with optional domains and IP/CIDR ranges, as a target this app can deploy configuration to.',
            }}
          />
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title="Add server"
        description="Register a deployment target — a server, with optional domains and IP/CIDR ranges."
        onSubmit={handleSubmit}
        submitText="Add server"
        isSubmitting={submitting}
        submitDisabled={!form.hostname.trim()}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Input
              label="Hostname"
              value={form.hostname}
              onChange={(e) => setField('hostname', e.target.value)}
              placeholder="e.g. splunk-idx-01.corp.example.com"
              fullWidth
              autoFocus
            />
            <Input
              label="Port"
              value={form.port}
              onChange={(e) => setField('port', e.target.value)}
              placeholder="e.g. 8089"
              fullWidth
            />
          </div>
          <Input
            label="Domains"
            value={form.domains}
            onChange={(e) => setField('domains', e.target.value)}
            placeholder="Comma-separated, e.g. corp.example.com, example.net"
            fullWidth
          />
          <Input
            label="IP ranges"
            value={form.ipRanges}
            onChange={(e) => setField('ipRanges', e.target.value)}
            placeholder="Comma-separated, e.g. 10.0.0.0/24, 192.168.1.10"
            fullWidth
          />
        </div>
      </FormDialog>
    </Card>
  )
}
