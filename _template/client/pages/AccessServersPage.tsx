// =============================================================================
// Access Servers — the Zero-Trust Access (ZTNA) gateways this app manages.
//
// Each Access Server is a ZTNA gateway (name + endpoint) the customer has
// registered, optionally linked to one of their connectivity providers. This
// page lists them and lets an operator create, edit, and remove servers, using
// the typed helpers from '@veltrixsecops/app-sdk/client' — no bespoke API
// plumbing required. Compose the body from '@veltrixsecops/app-sdk/ui' so it
// inherits the tenant's theme and your app's branding.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import {
  listAccessServers,
  addAccessServer,
  updateAccessServer,
  removeAccessServer,
  listConnectivityProviders,
  type AccessServer,
  type AccessServerInput,
  type ConnectivityProviderRef,
} from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Input,
  Select,
  FormDialog,
  DataTable,
  type DataTableColumn,
} from '@veltrixsecops/app-sdk/ui'

/** Map an access server's status to a Badge variant. */
function statusVariant(status?: string): 'success' | 'warning' | 'secondary' {
  const value = (status ?? '').toLowerCase()
  if (value === 'active' || value === 'healthy' || value === 'connected') return 'success'
  if (value === 'degraded' || value === 'pending' || value === 'error' || value === 'offline') {
    return 'warning'
  }
  return 'secondary'
}

interface FormState {
  name: string
  endpoint: string
  type: string
  region: string
  description: string
  /** Linked ZTNA connectivity provider id; '' means "— None —" (stored as null). */
  connectivityProviderId: string
}

const BLANK_FORM: FormState = {
  name: '',
  endpoint: '',
  type: 'gateway',
  region: '',
  description: '',
  connectivityProviderId: '',
}

/**
 * Access Servers page — full CRUD over the platform's ZTNA gateways, each
 * linkable to a connectivity provider. Modeled on the platform CRUD pattern:
 * FormDialog + DataTable + the SDK's framework-free access-server helpers.
 */
export default function AccessServersPage() {
  const [servers, setServers] = useState<AccessServer[]>([])
  const [providers, setProviders] = useState<ConnectivityProviderRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AccessServer | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return listAccessServers()
      .then((data) => setServers(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  // Connectivity providers back the ZTNA link picker. Loaded best-effort so a
  // providers hiccup never blocks the access-server list from rendering.
  const loadProviders = useCallback(() => {
    return listConnectivityProviders()
      .then((data) => setProviders(data))
      .catch(() => setProviders([]))
  }, [])

  useEffect(() => {
    void load()
    void loadProviders()
  }, [load, loadProviders])

  const openCreate = () => {
    setEditing(null)
    setForm(BLANK_FORM)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: AccessServer) => {
    setEditing(row)
    setForm({
      name: row.name ?? '',
      endpoint: row.endpoint ?? '',
      type: row.type ?? 'gateway',
      region: row.region ?? '',
      description: row.description ?? '',
      connectivityProviderId: row.connectivityProviderId ?? row.connectivityProvider?.id ?? '',
    })
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
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    if (!form.endpoint.trim()) {
      setFormError('Endpoint is required')
      return
    }
    setSubmitting(true)
    setFormError(null)
    const payload: AccessServerInput = {
      name: form.name.trim(),
      endpoint: form.endpoint.trim(),
      type: form.type.trim() || 'gateway',
      region: form.region.trim() || undefined,
      description: form.description.trim() || undefined,
      // Empty string means "— None —": send null to unlink.
      connectivityProviderId: form.connectivityProviderId ? form.connectivityProviderId : null,
    }
    try {
      if (editing) {
        await updateAccessServer(editing.id, payload)
      } else {
        await addAccessServer(payload)
      }
      setDialogOpen(false)
      await load()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (row: AccessServer) => {
    if (!window.confirm(`Remove access server "${row.name}"? This cannot be undone.`)) return
    try {
      await removeAccessServer(row.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const providerOptions = [
    { value: '', label: '— None —' },
    ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
  ]

  const columns: DataTableColumn<AccessServer>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'endpoint', header: 'Endpoint', render: (row) => row.endpoint || '—' },
    { key: 'type', header: 'Type', render: (row) => row.type || '—' },
    { key: 'region', header: 'Region', render: (row) => row.region || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.status ? (
          <Badge variant={statusVariant(row.status)} size="sm">
            {row.status}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'connectivityProvider',
      header: 'ZTNA provider',
      render: (row) => row.connectivityProvider?.name ?? '—',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleDelete(row)}>
            Remove
          </Button>
        </div>
      ),
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
              New access server
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Access Servers</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load access servers: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={servers}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No access servers yet',
              description:
                'Add a Zero-Trust Access gateway (name + endpoint), optionally linked to a ZTNA connectivity provider.',
            }}
          />
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit "${editing.name}"` : 'New access server'}
        description="A Zero-Trust Access gateway this app manages, optionally linked to a ZTNA connectivity provider."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Add access server'}
        isSubmitting={submitting}
        submitDisabled={!form.name.trim() || !form.endpoint.trim()}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Name"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="e.g. edge-gateway-1"
              fullWidth
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <Input
              label="Endpoint"
              value={form.endpoint}
              onChange={(e) => setField('endpoint', e.target.value)}
              placeholder="e.g. gw1.corp.example.com:443"
              fullWidth
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Type"
              value={form.type}
              onChange={(e) => setField('type', e.target.value)}
              placeholder="gateway"
              fullWidth
              spellCheck={false}
              autoComplete="off"
            />
            <Input
              label="Region (optional)"
              value={form.region}
              onChange={(e) => setField('region', e.target.value)}
              placeholder="e.g. us-east-1"
              fullWidth
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <Input
            label="Description (optional)"
            value={form.description}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="What this gateway fronts"
            fullWidth
          />
          <Select
            label="ZTNA link"
            options={providerOptions}
            value={form.connectivityProviderId}
            onChange={(value) => setField('connectivityProviderId', value)}
            helperText="Link this access server to a Zero-Trust Access connectivity provider."
            fullWidth
          />
        </div>
      </FormDialog>
    </Card>
  )
}
