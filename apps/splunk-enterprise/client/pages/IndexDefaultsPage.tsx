import React, { useCallback, useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Badge,
  Checkbox,
  Input,
  FormDialog,
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
  maxEventSize?: number
  retentionPeriod?: number
  searchablePeriod?: number
  frozenTimePeriod?: number
  enableCompression?: boolean
  enableTsidx?: boolean
  requireApproval?: boolean
  updatedAt?: string
  environments?: EnvironmentTag[]
}

interface FormState {
  name: string
  retentionPeriod: string
  searchablePeriod: string
  frozenTimePeriod: string
  maxEventSize: string
  enableCompression: boolean
  enableTsidx: boolean
  requireApproval: boolean
}

const BLANK_FORM: FormState = {
  name: '',
  retentionPeriod: '30',
  searchablePeriod: '15',
  frozenTimePeriod: '90',
  maxEventSize: '10000',
  enableCompression: true,
  enableTsidx: true,
  requireApproval: true,
}

const API = '/api/apps/splunk-enterprise/indexes/defaults'

function formatDate(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

function toForm(row: IndexDefaultConfig): FormState {
  return {
    name: row.name ?? '',
    retentionPeriod: String(row.retentionPeriod ?? 30),
    searchablePeriod: String(row.searchablePeriod ?? 15),
    frozenTimePeriod: String(row.frozenTimePeriod ?? 90),
    maxEventSize: String(row.maxEventSize ?? 10000),
    enableCompression: row.enableCompression ?? true,
    enableTsidx: row.enableTsidx ?? true,
    requireApproval: row.requireApproval ?? true,
  }
}

async function errorText(res: Response): Promise<string> {
  return res
    .json()
    .then((b: { error?: string }) => b?.error || `HTTP ${res.status}`)
    .catch(() => `HTTP ${res.status}`)
}

/**
 * Manage the customer's default index configurations — the per-environment
 * templates that seed new index configs (retention, sizing, compression,
 * approval policy). Full CRUD over the app's /indexes/defaults routes.
 */
export default function IndexDefaultsPage() {
  const [configs, setConfigs] = useState<IndexDefaultConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<IndexDefaultConfig | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch(API)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: IndexDefaultConfig[]) => setConfigs(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(BLANK_FORM)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: IndexDefaultConfig) => {
    setEditing(row)
    setForm(toForm(row))
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
    setSubmitting(true)
    setFormError(null)
    const payload = {
      name: form.name.trim(),
      retentionPeriod: Number(form.retentionPeriod),
      searchablePeriod: Number(form.searchablePeriod),
      frozenTimePeriod: Number(form.frozenTimePeriod),
      maxEventSize: Number(form.maxEventSize),
      enableCompression: form.enableCompression,
      enableTsidx: form.enableTsidx,
      requireApproval: form.requireApproval,
    }
    try {
      const res = await authFetch(editing ? `${API}/${editing.id}` : API, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await errorText(res))
      setDialogOpen(false)
      await load()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (row: IndexDefaultConfig) => {
    if (!window.confirm(`Delete index default "${row.name}"? This cannot be undone.`)) return
    try {
      const res = await authFetch(`${API}/${row.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res))
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

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
            Delete
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
              New default
            </Button>
          </div>
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
              description: 'Create a default template that seeds new index configurations per environment.',
            }}
          />
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit "${editing.name}"` : 'New index default'}
        description="Default settings applied when seeding new index configurations."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Create default'}
        isSubmitting={submitting}
        submitDisabled={!form.name.trim()}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="e.g. Standard retention"
            fullWidth
            autoFocus
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Retention (days)"
              type="number"
              value={form.retentionPeriod}
              onChange={(e) => setField('retentionPeriod', e.target.value)}
              fullWidth
            />
            <Input
              label="Searchable (days)"
              type="number"
              value={form.searchablePeriod}
              onChange={(e) => setField('searchablePeriod', e.target.value)}
              fullWidth
            />
            <Input
              label="Frozen after (days)"
              type="number"
              value={form.frozenTimePeriod}
              onChange={(e) => setField('frozenTimePeriod', e.target.value)}
              fullWidth
            />
            <Input
              label="Max event size (bytes)"
              type="number"
              value={form.maxEventSize}
              onChange={(e) => setField('maxEventSize', e.target.value)}
              fullWidth
            />
          </div>
          <Checkbox
            label="Enable compression"
            checked={form.enableCompression}
            onChange={(e) => setField('enableCompression', e.target.checked)}
          />
          <Checkbox
            label="Enable TSIDX reduction"
            checked={form.enableTsidx}
            onChange={(e) => setField('enableTsidx', e.target.checked)}
          />
          <Checkbox
            label="Require approval before deploy"
            checked={form.requireApproval}
            onChange={(e) => setField('requireApproval', e.target.checked)}
          />
        </div>
      </FormDialog>
    </Card>
  )
}
