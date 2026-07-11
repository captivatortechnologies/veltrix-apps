import React, { useCallback, useEffect, useState } from 'react'
import {
  listCredentials,
  createCredential,
  updateCredential,
  removeCredential,
  listEnvironments,
  resolveTool,
  type CredentialSummary,
  type EnvironmentRef,
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

// The platform Tool is upserted keyed by the app's manifest name; resolveTool
// matches on it so new connections attach to this app's tool.
const APP_NAME = 'CrowdStrike Falcon'

// How a connection authenticates. The secret is write-only: for "token" it is
// the Falcon API client secret, for "password" it is the account password.
const AUTH_TYPES = [
  { value: 'token', label: 'API client (id + secret)' },
  { value: 'password', label: 'Username & password' },
]

// Map the auth choice to/from the platform credential `type`. Token secrets are
// only encrypted at rest for 'API_KEY'/'TOKEN' — so token auth stores 'TOKEN'.
function toCredentialType(authType: string): string {
  return authType === 'token' ? 'TOKEN' : 'PASSWORD'
}
function fromCredentialType(type: string | null | undefined): string {
  return type === 'TOKEN' ? 'token' : 'password'
}

interface FormState {
  name: string
  environmentId: string
  authType: string
  username: string
  secret: string
  endpoint: string
}

const BLANK_FORM: FormState = {
  name: '',
  environmentId: '',
  authType: 'token',
  username: '',
  secret: '',
  endpoint: '',
}

/**
 * Connections — the credentials this app authenticates to the CrowdStrike
 * Falcon APIs with (an API client id + secret, or a username/password) plus the
 * API endpoint each reaches. Secrets are write-only: they can be set here but
 * are never read back — the table only shows whether a secret is stored.
 */
export default function ConnectionsPage() {
  const [connections, setConnections] = useState<CredentialSummary[]>([])
  const [environments, setEnvironments] = useState<EnvironmentRef[]>([])
  const [toolId, setToolId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CredentialSummary | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const tool = await resolveTool(APP_NAME)
      setToolId(tool?.id ?? null)
      const [creds, envs] = await Promise.all([
        tool ? listCredentials(tool.id) : Promise.resolve([] as CredentialSummary[]),
        listEnvironments(),
      ])
      setConnections(creds)
      setEnvironments(envs)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setIsLoading(false)
    }
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

  const openEdit = (row: CredentialSummary) => {
    setEditing(row)
    setForm({
      name: row.name ?? '',
      environmentId: row.tags?.[0]?.id ?? '',
      authType: fromCredentialType(row.type),
      username: row.username ?? '',
      // Secret is write-only; start blank and only rotate when the user types.
      secret: '',
      endpoint: row.endpoint ?? '',
    })
    setFormError(null)
    setDialogOpen(true)
  }

  // Memoized so FormDialog's focus effect doesn't steal focus while typing.
  const closeDialog = useCallback(() => {
    if (submitting) return
    setDialogOpen(false)
  }, [submitting])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleSubmit = async () => {
    const name = form.name.trim()
    if (!name) {
      setFormError('Name is required')
      return
    }
    if (!form.environmentId) {
      setFormError('Environment is required')
      return
    }
    setSubmitting(true)
    setFormError(null)

    const secret = form.secret.trim()
    const username = form.username.trim()
    const endpoint = form.endpoint.trim()
    const tagIds = [form.environmentId]

    try {
      if (editing) {
        const update: Record<string, unknown> = {
          name,
          username,
          type: toCredentialType(form.authType),
          endpoint,
          tagIds,
        }
        if (secret) {
          if (form.authType === 'token') update.apiToken = secret
          else update.password = secret
        }
        await updateCredential(editing.id, update)
      } else {
        const tool = await resolveTool(APP_NAME)
        if (!tool) {
          throw new Error(
            `No "${APP_NAME}" tool found for your organization — make sure the app is installed before adding connections.`,
          )
        }
        await createCredential({
          name,
          username,
          password: form.authType === 'password' ? secret : '',
          apiToken: form.authType === 'token' ? secret : undefined,
          type: toCredentialType(form.authType),
          endpoint,
          toolId: tool.id,
          tagIds,
        })
      }
      setDialogOpen(false)
      await load()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (row: CredentialSummary) => {
    if (!window.confirm(`Remove the connection "${row.name}"? This cannot be undone.`)) return
    try {
      await removeCredential(row.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const columns: DataTableColumn<CredentialSummary>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    {
      key: 'environment',
      header: 'Environment',
      render: (row) =>
        row.tags && row.tags.length > 0 ? (
          <Badge variant="info" size="sm">
            {row.tags[0].name}
          </Badge>
        ) : (
          <Badge variant="warning" size="sm">
            none
          </Badge>
        ),
    },
    { key: 'username', header: 'Client ID / Username', render: (row) => row.username || '—' },
    {
      key: 'auth',
      header: 'Auth',
      render: (row) => (
        <Badge variant={row.hasSecret ? 'success' : 'warning'} size="sm">
          {row.type === 'TOKEN' ? 'api client' : 'password'}
          {row.hasSecret ? '' : ' · no secret'}
        </Badge>
      ),
    },
    { key: 'endpoint', header: 'Endpoint', render: (row) => row.endpoint || '—' },
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

  const secretLabel = form.authType === 'token' ? 'Client secret' : 'Password'
  const usernameLabel = form.authType === 'token' ? 'Client ID' : 'Username'
  const environmentOptions = [
    { value: '', label: environments.length ? '— Select environment —' : '— No environments —' },
    ...environments.map((e) => ({ value: e.id, label: e.name })),
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
              Add connection
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Connections</h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p role="alert">Failed to load connections: {error}</p>
        ) : (
          <DataTable
            columns={columns}
            data={connections}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No connections yet',
              description:
                'Add the credentials this app authenticates with (API client id + secret, or username/password) and the Falcon endpoint they reach.',
            }}
          />
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit connection "${editing.name}"` : 'Add connection'}
        description="Credentials this app authenticates to the Falcon APIs with, plus the API endpoint they reach."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Add connection'}
        isSubmitting={submitting}
        submitDisabled={!form.name.trim() || !form.environmentId}
        error={formError}
        size="md"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="e.g. Falcon API client"
            fullWidth
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <Select
            label="Environment"
            options={environmentOptions}
            value={form.environmentId}
            onChange={(value) => setField('environmentId', value)}
            helperText="The deployment scope this connection belongs to. Manage environments under Environments."
            fullWidth
          />
          <Input
            label="Endpoint (optional)"
            value={form.endpoint}
            onChange={(e) => setField('endpoint', e.target.value)}
            placeholder="e.g. https://api.crowdstrike.com"
            helperText="API base URL / endpoint this connection reaches."
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          <Select
            label="Auth method"
            options={AUTH_TYPES}
            value={form.authType}
            onChange={(value) => setField('authType', value)}
            fullWidth
          />
          <Input
            label={usernameLabel}
            value={form.username}
            onChange={(e) => setField('username', e.target.value)}
            placeholder={form.authType === 'token' ? 'API client ID' : 'e.g. falcon-admin'}
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          <Input
            label={secretLabel}
            type="password"
            value={form.secret}
            onChange={(e) => setField('secret', e.target.value)}
            placeholder={editing ? 'leave blank to keep current' : ''}
            helperText="Write-only — stored securely and never shown again."
            fullWidth
            autoComplete="new-password"
          />
        </div>
      </FormDialog>
    </Card>
  )
}
