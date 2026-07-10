// =============================================================================
// Connections — the built-in "server + credential" surface every app can share.
//
// A "connection" pairs a server (the platform's *component*: hostname/port,
// domains, IP/CIDR ranges) with the *credential* used to reach it. This page
// lists connections and lets an operator add, edit, or remove one, using the
// typed helpers from '@veltrixsecops/app-sdk/client' — inventory helpers for the
// server and credential helpers for the auth — with no bespoke API plumbing.
//
// Secrets are WRITE-ONLY: they can be set here but are never read back. The
// table only shows whether a secret is stored (`hasSecret`).
//
// Rendered under the app's Settings nav group (manifest `group: settings`).
// Compose the body from '@veltrixsecops/app-sdk/ui' so it inherits the tenant's
// theme and your app's branding.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import {
  listInventory,
  addInventoryItem,
  updateInventoryItem,
  removeInventoryItem,
  listCredentials,
  createCredential,
  updateCredential,
  removeCredential,
  resolveTool,
  type InventoryItem,
  type CredentialSummary,
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

// CHANGE ME: the platform upserts a Tool keyed by your manifest `name` on
// install; resolveTool matches on it so new connections attach to your app's
// tool. Set this to your manifest's `name` value exactly.
const APP_NAME = 'My Security App'

// CHANGE ME: the kinds of server/endpoint your app connects to. A component's
// `type` is an array; the form edits a single primary type.
const SERVER_TYPES = [
  { value: 'server', label: 'Server' },
  { value: 'gateway', label: 'Gateway' },
  { value: 'endpoint', label: 'API Endpoint' },
  { value: 'agent', label: 'Agent' },
  { value: 'collector', label: 'Collector' },
]
const KNOWN_TYPES = new Set(SERVER_TYPES.map((t) => t.value))

// How the app authenticates to a server. The secret travels write-only: for
// "password" it is the account password, for "token" it is an API token.
const AUTH_TYPES = [
  { value: 'password', label: 'Username & password' },
  { value: 'token', label: 'API token' },
]

// Map the form's auth choice to/from the platform credential `type`. These
// EXACT values matter for security: the platform encrypts the apiToken secret
// at rest only when type is 'API_KEY' or 'TOKEN' (see the credential service's
// shouldEncrypt) — so token auth MUST store 'TOKEN', never a lowercase value.
// The password field is always encrypted regardless of type.
function toCredentialType(authType: string): string {
  return authType === 'token' ? 'TOKEN' : 'PASSWORD'
}
function fromCredentialType(type: string | null | undefined): string {
  return type === 'TOKEN' ? 'token' : 'password'
}

function isKnownTarget(item: InventoryItem): boolean {
  if (!item.type || item.type.length === 0) return true
  return item.type.some((t) => KNOWN_TYPES.has(t))
}

function commaList(values?: string[]): string {
  return values && values.length > 0 ? values.join(', ') : '—'
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * A connection: a server (component) paired with its credential. The credential
 * is matched to the server by convention — `credential.name === hostname` — so a
 * single row shows both without a schema-level join.
 */
interface Connection {
  component: InventoryItem
  credential: CredentialSummary | null
}

interface FormState {
  hostname: string
  port: string
  type: string
  domains: string
  ipRanges: string
  authType: string
  username: string
  secret: string
}

const BLANK_FORM: FormState = {
  hostname: '',
  port: '',
  type: 'server',
  domains: '',
  ipRanges: '',
  authType: 'password',
  username: '',
  secret: '',
}

/**
 * Connections page — lists "server + credential" pairs and lets an operator add,
 * edit, or remove one. Modeled on the platform CRUD pattern: FormDialog +
 * DataTable + the SDK's framework-free inventory and credential helpers.
 */
export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [toolId, setToolId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Connection | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      // Resolve the app's tool up front so we can both create connections and
      // read the tool's credentials to pair with each server.
      const tool = await resolveTool(APP_NAME)
      setToolId(tool?.id ?? null)
      const [components, credentials] = await Promise.all([
        listInventory(),
        tool ? listCredentials(tool.id) : Promise.resolve([] as CredentialSummary[]),
      ])
      const byName = new Map(credentials.map((c) => [c.name, c]))
      setConnections(
        components.filter(isKnownTarget).map((component) => ({
          component,
          credential: byName.get(component.hostname) ?? null,
        })),
      )
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

  const openEdit = (row: Connection) => {
    setEditing(row)
    setForm({
      hostname: row.component.hostname ?? '',
      port: row.component.port ?? '',
      type: row.component.type?.[0] ?? 'server',
      domains: (row.component.domains ?? []).join(', '),
      ipRanges: (row.component.ipRanges ?? []).join(', '),
      authType: fromCredentialType(row.credential?.type),
      username: row.credential?.username ?? '',
      // Secret is write-only; start blank and only rotate when the user types.
      secret: '',
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
    const hostname = form.hostname.trim()
    if (!hostname) {
      setFormError('Hostname is required')
      return
    }
    setSubmitting(true)
    setFormError(null)

    const componentPayload = {
      hostname,
      port: form.port.trim() || undefined,
      type: [form.type],
      domains: splitCsv(form.domains),
      ipRanges: splitCsv(form.ipRanges),
    }
    const secret = form.secret.trim()
    const username = form.username.trim()
    const wantsCredential = username !== '' || secret !== ''

    try {
      if (editing) {
        await updateInventoryItem(editing.component.id, componentPayload)
        const existing = editing.credential
        if (existing) {
          const update: Record<string, unknown> = {
            name: hostname,
            username,
            type: toCredentialType(form.authType),
          }
          if (secret) {
            if (form.authType === 'token') update.apiToken = secret
            else update.password = secret
          }
          await updateCredential(existing.id, update)
        } else if (wantsCredential && toolId) {
          await createCredential({
            name: hostname,
            username,
            password: form.authType === 'password' ? secret : '',
            apiToken: form.authType === 'token' ? secret : undefined,
            type: toCredentialType(form.authType),
            toolId,
          })
        }
      } else {
        // New connections must be attached to this app's tool.
        const tool = await resolveTool(APP_NAME)
        if (!tool) {
          throw new Error(
            `No "${APP_NAME}" tool found for your organization — make sure the app is installed before adding connections.`,
          )
        }
        await addInventoryItem({ ...componentPayload, toolId: tool.id })
        if (wantsCredential) {
          await createCredential({
            name: hostname,
            username,
            password: form.authType === 'password' ? secret : '',
            apiToken: form.authType === 'token' ? secret : undefined,
            type: toCredentialType(form.authType),
            toolId: tool.id,
          })
        }
      }
      setDialogOpen(false)
      await load()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (row: Connection) => {
    if (
      !window.confirm(
        `Remove the connection to "${row.component.hostname}"? This deletes the server and its credential and cannot be undone.`,
      )
    )
      return
    try {
      await removeInventoryItem(row.component.id)
      if (row.credential) await removeCredential(row.credential.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const columns: DataTableColumn<Connection>[] = [
    { key: 'hostname', header: 'Hostname', render: (row) => <strong>{row.component.hostname}</strong> },
    {
      key: 'type',
      header: 'Type',
      render: (row) =>
        row.component.type && row.component.type.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {row.component.type.map((t) => (
              <Badge key={t} variant="secondary" size="sm">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          '—'
        ),
    },
    { key: 'port', header: 'Port', align: 'right', render: (row) => row.component.port ?? '—' },
    {
      key: 'auth',
      header: 'Credential',
      render: (row) =>
        row.credential ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{row.credential.username || '—'}</span>
            <Badge variant={row.credential.hasSecret ? 'success' : 'secondary'} size="sm">
              {row.credential.hasSecret ? (row.credential.type === 'TOKEN' ? 'token' : 'secret set') : 'no secret'}
            </Badge>
          </div>
        ) : (
          <Badge variant="warning" size="sm">
            no credential
          </Badge>
        ),
    },
    { key: 'domains', header: 'Domains', render: (row) => commaList(row.component.domains) },
    { key: 'ipRanges', header: 'IP ranges', render: (row) => commaList(row.component.ipRanges) },
    {
      key: 'tags',
      header: 'Tags',
      render: (row) =>
        row.component.tags && row.component.tags.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {row.component.tags.map((tag) => (
              <Badge key={tag.id} variant="secondary" size="sm">
                {tag.name}
              </Badge>
            ))}
          </div>
        ) : (
          '—'
        ),
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

  const secretLabel = form.authType === 'token' ? 'API token' : 'Password'
  const usernameLabel = form.authType === 'token' ? 'Username (optional)' : 'Username'

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
            rowKey={(row) => row.component.id}
            isLoading={isLoading}
            emptyState={{
              title: 'No connections yet',
              description: 'Register a server (hostname/port) and the credential used to reach it.',
            }}
          />
        )}
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit connection to "${editing.component.hostname}"` : 'Add connection'}
        description="A server the app connects to, plus the credential used to authenticate."
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Add connection'}
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
              placeholder="e.g. host.corp.example.com"
              fullWidth
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <Input
              label="Port"
              value={form.port}
              onChange={(e) => setField('port', e.target.value)}
              placeholder="e.g. 443"
              fullWidth
            />
          </div>
          <Select
            label="Type"
            options={SERVER_TYPES}
            value={form.type}
            onChange={(value) => setField('type', value)}
            fullWidth
          />
          <Input
            label="Domains (optional)"
            value={form.domains}
            onChange={(e) => setField('domains', e.target.value)}
            placeholder="comma-separated DNS names"
            helperText="Extra DNS names this server is reachable at."
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />
          <Input
            label="IP ranges (optional)"
            value={form.ipRanges}
            onChange={(e) => setField('ipRanges', e.target.value)}
            placeholder="comma-separated IP/CIDR, e.g. 10.0.1.0/24"
            helperText="IPs or CIDR ranges this server covers."
            fullWidth
            spellCheck={false}
            autoComplete="off"
          />

          <div style={{ borderTop: '1px solid var(--vx-border, #e5e7eb)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Credential</h3>
              <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.7 }}>
                How the app authenticates to this server. Leave blank to register the server without a credential.
              </p>
            </div>
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
              placeholder={form.authType === 'token' ? 'service account (optional)' : 'e.g. svc_account'}
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
        </div>
      </FormDialog>
    </Card>
  )
}
