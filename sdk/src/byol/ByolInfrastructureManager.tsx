import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { authFetch } from '../client'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Input,
  Select,
  Alert,
  Tooltip,
  FormDialog,
  DataTable,
  FilterBar,
  SortSelect,
  Pagination,
  type DataTableColumn,
  type FilterDefinition,
  type SortOption,
} from '../ui'
import {
  type ByolInfrastructure,
  type ByolInfrastructureManagerProps,
  type ByolTopology,
  type ClusterPlacement,
  type Tag,
  type CloudProvider,
  type CloudRegion,
  type CloudAccount,
  type FormState,
  SELF_HOSTED,
  SELF_HOSTED_LABEL,
  DEFAULT_DEPLOYMENT_TYPES,
  DEFAULT_SPLUNK_TOPOLOGY,
  NETWORK_MODE_OPTIONS,
  DNS_MODE_OPTIONS,
  BYOC_NETWORK_MODES,
  CONTROL_PLANE_LAYOUT_OPTIONS,
  INSTANCE_TYPE_EXAMPLES,
  blankForm,
  editFormState,
  tierValue,
} from './types'
import { StatusPill, tokens } from './detail/shared'
import { errorText, formatDate } from './api'
import { ByolInfrastructureDetail } from './ByolInfrastructureDetail'
import { ClusterPlacementField } from './ClusterPlacementField'
import { validatePlacement } from './placement'

/** A small keyboard-focusable ⓘ affordance next to the card title; renders nothing without a tooltip. */
const TopologyInfoIcon: React.FC<{ tooltip?: string }> = ({ tooltip }) => {
  if (!tooltip) return null
  return (
    <Tooltip content={tooltip} placement="right">
      <button
        type="button"
        aria-label={tooltip}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: `1px solid ${tokens.border}`,
          background: 'none',
          color: tokens.muted,
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          cursor: 'default',
          padding: 0,
        }}
      >
        i
      </button>
    </Tooltip>
  )
}

/**
 * Reusable BYOL infrastructure manager: a searchable/filterable list whose rows
 * open a full deployment console (the detail view), a Provider picker (platform
 * cloud providers plus Self-Hosted), an Environment picker fed by the customer's
 * tags, and a cloud region picker shown only for a distributed cloud deployment.
 * The app owns the data (its own DB table + routes); this component owns the UI.
 */
export const ByolInfrastructureManager: React.FC<ByolInfrastructureManagerProps> = ({
  apiBase,
  title = 'BYOL Infrastructure',
  deploymentTypes = DEFAULT_DEPLOYMENT_TYPES,
  configBase,
  configLinks,
  versionOptions = [],
  defaultVersionId,
  topology,
}) => {
  const topo = topology ?? DEFAULT_SPLUNK_TOPOLOGY
  // Avoids a stray double space in the fallback sentence when an app omits productName.
  const dialogDescription = (
    topo.description ?? `Define the deployment topology for a Bring-Your-Own-License ${topo.productName ?? ''} environment.`
  )
    .replace(/\s{2,}/g, ' ')
    .trim()
  const [infrastructure, setInfrastructure] = useState<ByolInfrastructure[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [cloudProviders, setCloudProviders] = useState<CloudProvider[]>([])
  const [regions, setRegions] = useState<CloudRegion[]>([])
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Master→detail: which infrastructure (if any) is open.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('infra')
  })
  const [reloadSignal, setReloadSignal] = useState(0)

  const [search, setSearch] = useState('')
  const [environmentFilter, setEnvironmentFilter] = useState<string | null>(null)
  const [deploymentFilter, setDeploymentFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [sortField, setSortField] = useState('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ByolInfrastructure | null>(null)
  const [form, setForm] = useState<FormState>(() => blankForm(topo))
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    return authFetch(apiBase)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: ByolInfrastructure[]) => setInfrastructure(Array.isArray(data) ? data : []))
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [apiBase])

  useEffect(() => {
    void load()
  }, [load])

  // Reference lists: environment tags + platform cloud providers + cloud account
  // connections (for BYOC deployment targets). Best-effort.
  useEffect(() => {
    authFetch('/api/tags')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Tag[]) => setTags(Array.isArray(data) ? data : []))
      .catch(() => setTags([]))
    authFetch('/api/cloud-providers')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CloudProvider[]) =>
        setCloudProviders(Array.isArray(data) ? data.filter((c) => c.isActive !== false) : []),
      )
      .catch(() => setCloudProviders([]))
    authFetch('/api/cloud-accounts')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CloudAccount[]) => setCloudAccounts(Array.isArray(data) ? data : []))
      .catch(() => setCloudAccounts([]))
  }, [])

  const isCloud = form.providerId !== '' && form.providerId !== SELF_HOSTED
  const showRegion = isCloud && form.deploymentType === 'distributed'
  // Every cloud deploy can pick a verified account — the tenant's own (customer)
  // for BYOC, or a Veltrix-managed (platform) account for a hosted deploy. BYOC
  // (dedicated/existing) REQUIRES one (whose VPC to use); hosted (shared) is
  // optional (falls back to the default provisioning identity).
  const isByoc = BYOC_NETWORK_MODES.has(form.networkMode)
  const showCloudAccount = isCloud
  // A BYOC (dedicated/existing) target needs a cloud account — but only for a CLOUD
  // deploy. Self-hosted ignores networkMode entirely, so it must never gate Save on
  // an account it doesn't even show a picker for.
  const cloudAccountRequired = isByoc && isCloud

  // Load the selected cloud provider's regions when needed for the region picker.
  useEffect(() => {
    if (!isCloud) {
      setRegions([])
      return
    }
    let cancelled = false
    authFetch(`/api/cloud-providers/${form.providerId}/regions`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: CloudRegion[]) => {
        if (!cancelled) setRegions(Array.isArray(data) ? data.filter((r) => r.isActive !== false) : [])
      })
      .catch(() => {
        if (!cancelled) setRegions([])
      })
    return () => {
      cancelled = true
    }
  }, [isCloud, form.providerId])

  const openCreate = () => {
    setEditing(null)
    // A fresh infrastructure defaults its version to the app-supplied "latest"
    // (defaultVersionId) when one is available; an existing row's Edit form
    // always reflects its own stored versionId instead (see editFormState).
    setForm({ ...blankForm(topo), versionId: defaultVersionId ?? '' })
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (row: ByolInfrastructure) => {
    setEditing(row)
    setForm(editFormState(row, topo))
    setFormError(null)
    setDialogOpen(true)
  }

  const closeDialog = useCallback(() => {
    if (submitting) return
    setDialogOpen(false)
  }, [submitting])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const setTierCount = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, tierCounts: { ...prev.tierCounts, [key]: value } }))

  const setTierPlacement = (key: string, value: ClusterPlacement) =>
    setForm((prev) => ({ ...prev, tierPlacement: { ...prev.tierPlacement, [key]: value } }))

  // A cloud account is scoped to a provider — switching providers invalidates any
  // previously selected account (the Cloud account options are recomputed to match
  // the new provider, so keeping the stale id around would let it slip into submit).
  const handleProviderChange = (value: string) =>
    setForm((prev) => ({ ...prev, providerId: value, cloudAccountConnectionId: '' }))

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    const distributed = form.deploymentType === 'distributed'
    if (distributed) {
      for (const t of topo.tiers) {
        const min = t.min ?? 1
        const count = Number(form.tierCounts[t.key])
        if (count < min) {
          setFormError(`Distributed deployments require at least ${min} ${t.label.toLowerCase()}`)
          return
        }
        if (showRegion && t.placeable !== false) {
          const err = validatePlacement(form.tierPlacement[t.key], count)
          if (err) {
            setFormError(`${t.label} placement: ${err}`)
            return
          }
        }
      }
    }
    if (cloudAccountRequired && !form.cloudAccountConnectionId) {
      setFormError('Select a verified cloud account for a BYOC deployment target')
      return
    }
    const selfHosted = form.providerId === SELF_HOSTED
    const selectedCloud = cloudProviders.find((c) => c.id === form.providerId)
    // Placement only applies to a distributed cloud deployment (needs AZs/regions);
    // single-instance or self-hosted always collapses to a single site.
    const normalizePlacement = (p: ClusterPlacement | undefined): ClusterPlacement =>
      distributed && showRegion && p?.mode === 'multi-site' ? p : { mode: 'single' as const }
    setSubmitting(true)
    setFormError(null)
    const payload = {
      name: form.name.trim(),
      deploymentType: form.deploymentType,
      environmentType: form.environmentType,
      hosting_type: selfHosted ? SELF_HOSTED_LABEL : (selectedCloud?.name ?? ''),
      cloudProviderId: selfHosted ? undefined : form.providerId || undefined,
      region: showRegion ? form.region : '',
      // Generic per-tier node counts + placement — replaces the old fixed
      // indexerCount/searchHeadCount pair so any app's topology round-trips.
      tiers: topo.tiers.map((t) => ({
        key: t.key,
        count: Number(form.tierCounts[t.key]) || 1,
        placement: distributed && t.placeable !== false ? normalizePlacement(form.tierPlacement[t.key]) : null,
      })),
      networkMode: form.networkMode,
      dnsMode: form.dnsMode,
      cloudAccountConnectionId: showCloudAccount ? form.cloudAccountConnectionId : undefined,
      // Topology authoring — only meaningful for distributed deployments.
      controlPlaneLayout: distributed ? form.controlPlaneLayout : 'dedicated',
      heavyForwarderCount: distributed ? Math.max(1, Number(form.heavyForwarderCount) || 1) : 1,
      // Compute size override; empty → the cloud default (t2.medium-class). Only
      // meaningful for a cloud deployment.
      instanceType: !selfHosted ? form.instanceType.trim() || undefined : undefined,
      versionId: form.versionId || undefined,
    }
    try {
      const res = await authFetch(editing ? `${apiBase}/${editing.id}` : apiBase, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await errorText(res))
      setDialogOpen(false)
      await load()
      // If we edited the open infrastructure, refresh the detail view too.
      if (editing) setReloadSignal((n) => n + 1)
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const openDetail = (id: string | null) => {
    setSelectedId(id)
    if (typeof window !== 'undefined' && id === null) {
      const params = new URLSearchParams(window.location.search)
      params.delete('infra')
      params.delete('section')
      const qs = params.toString()
      window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname)
    }
  }

  const columns: DataTableColumn<ByolInfrastructure>[] = [
    { key: 'name', header: 'Name', render: (row) => <strong>{row.name}</strong> },
    { key: 'deploymentType', header: 'Deployment', render: (row) => row.deploymentType ?? '—' },
    { key: 'environmentType', header: 'Environment', render: (row) => row.environmentType ?? '—' },
    { key: 'hosting_type', header: 'Provider', render: (row) => row.hosting_type ?? '—' },
    { key: 'region', header: 'Region', render: (row) => row.region || '—' },
    ...topo.tiers.map((t, i) => ({
      key: `tier:${t.key}`,
      header: t.shortLabel ?? t.label,
      align: 'right' as const,
      render: (row: ByolInfrastructure) => tierValue(row, t, i) ?? '—',
    })),
    { key: 'status', header: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'updatedAt', header: 'Updated', render: (row) => formatDate(row.updatedAt) },
    { key: 'chevron', header: '', align: 'right', width: '32px', render: () => <span aria-hidden style={{ color: tokens.faint }}>›</span> },
  ]

  const environmentOptions = useMemo(() => tags.map((t) => ({ value: t.name, label: t.name })), [tags])
  const providerOptions = useMemo(
    () => [
      { value: SELF_HOSTED, label: SELF_HOSTED_LABEL },
      ...cloudProviders.map((c) => ({ value: c.id, label: c.name })),
    ],
    [cloudProviders],
  )
  const regionOptions = useMemo(
    () => regions.map((r) => ({ value: r.code, label: `${r.name} (${r.code})` })),
    [regions],
  )
  const selectedProvider = useMemo(
    () => cloudProviders.find((c) => c.id === form.providerId),
    [cloudProviders, form.providerId],
  )
  // Only verified accounts, narrowed to the selected cloud provider (when one is picked).
  const verifiedCloudAccounts = useMemo(
    () =>
      cloudAccounts.filter(
        (a) => a.status === 'VERIFIED' && (!selectedProvider?.code || a.provider === selectedProvider.code),
      ),
    [cloudAccounts, selectedProvider],
  )
  const cloudAccountOptions = useMemo(
    () =>
      verifiedCloudAccounts.map((a) => ({
        value: a.id,
        label: `${a.name} (${a.provider}${a.scope === 'platform' ? ' · Veltrix-managed' : ''})`,
      })),
    [verifiedCloudAccounts],
  )

  const statusFilterOptions = useMemo(() => {
    const seen = new Set<string>()
    infrastructure.forEach((i) => seen.add(i.status ?? 'unknown'))
    return Array.from(seen, (value) => ({ value, label: value }))
  }, [infrastructure])

  const sortOptions: SortOption[] = [
    { value: 'name', label: 'Name' },
    ...topo.tiers.map((t) => ({ value: `tier:${t.key}`, label: t.shortLabel ?? t.label })),
    { value: 'status', label: 'Status' },
    { value: 'updatedAt', label: 'Updated' },
  ]
  const filters: FilterDefinition[] = [
    { key: 'environment', label: 'Environment', options: environmentOptions, value: environmentFilter, onChange: setEnvironmentFilter, alwaysVisible: true },
    { key: 'deployment', label: 'Deployment', options: deploymentTypes, value: deploymentFilter, onChange: setDeploymentFilter },
    { key: 'status', label: 'Status', options: statusFilterOptions, value: statusFilter, onChange: setStatusFilter },
  ]

  const filteredSorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const rows = infrastructure.filter((row) => {
      if (term) {
        const haystack = `${row.name ?? ''} ${row.hosting_type ?? ''} ${row.region ?? ''}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      if (environmentFilter && row.environmentType !== environmentFilter) return false
      if (deploymentFilter && row.deploymentType !== deploymentFilter) return false
      if (statusFilter && (row.status ?? 'unknown') !== statusFilter) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      if (sortField.startsWith('tier:')) {
        const key = sortField.slice('tier:'.length)
        const index = topo.tiers.findIndex((t) => t.key === key)
        const tier = topo.tiers[index]
        if (tier) return ((tierValue(a, tier, index) ?? 0) - (tierValue(b, tier, index) ?? 0)) * dir
      }
      switch (sortField) {
        case 'status':
          return (a.status ?? '').localeCompare(b.status ?? '') * dir
        case 'updatedAt':
          return (new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime()) * dir
        case 'name':
        default:
          return (a.name ?? '').localeCompare(b.name ?? '') * dir
      }
    })
  }, [infrastructure, search, environmentFilter, deploymentFilter, statusFilter, sortField, sortDir, topo])

  const pageRows = useMemo(
    () => filteredSorted.slice((page - 1) * pageSize, page * pageSize),
    [filteredSorted, page, pageSize],
  )

  useEffect(() => {
    setPage(1)
  }, [search, environmentFilter, deploymentFilter, statusFilter, sortField, sortDir])

  const selected = selectedId ? infrastructure.find((i) => i.id === selectedId) ?? null : null

  // --- Detail view (master→detail swap) ---
  if (selectedId && selected) {
    return (
      <>
        <ByolInfrastructureDetail
          apiBase={apiBase}
          initialInfra={selected}
          configBase={configBase}
          configLinks={configLinks}
          topology={topo}
          reloadSignal={reloadSignal}
          onBack={() => openDetail(null)}
          onEdit={openEdit}
          onDeleted={() => {
            openDetail(null)
            void load()
          }}
          onChanged={() => void load()}
        />
        <FormDialog
          isOpen={dialogOpen}
          onClose={closeDialog}
          title={editing ? `Edit "${editing.name}"` : 'New BYOL infrastructure'}
          description={dialogDescription}
          onSubmit={handleSubmit}
          submitText={editing ? 'Save changes' : 'Create infrastructure'}
          isSubmitting={submitting}
          submitDisabled={!form.name.trim() || (cloudAccountRequired && !form.cloudAccountConnectionId)}
          error={formError}
          size="md"
        >
          <FormBody
            form={form}
            setField={setField}
            setTierCount={setTierCount}
            setTierPlacement={setTierPlacement}
            topology={topo}
            onProviderChange={handleProviderChange}
            deploymentTypes={deploymentTypes}
            environmentOptions={environmentOptions}
            providerOptions={providerOptions}
            regionOptions={regionOptions}
            showRegion={showRegion}
            showCloudAccount={showCloudAccount}
            cloudAccountRequired={cloudAccountRequired}
            cloudAccountOptions={cloudAccountOptions}
            selectedProviderName={selectedProvider?.name}
            providerCode={selectedProvider?.code}
            versionOptions={versionOptions}
          />
        </FormDialog>
      </>
    )
  }

  // --- List view ---
  return (
    <Card variant="bordered">
      <CardHeader
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => void load()} isLoading={isLoading}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              New infrastructure
            </Button>
          </div>
        }
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          {title}
          <TopologyInfoIcon tooltip={topo.infoTooltip} />
        </h2>
      </CardHeader>
      <CardBody>
        {error ? (
          <p style={{ color: tokens.danger }}>Failed to load BYOL infrastructure: {error}</p>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <FilterBar
            search={{ value: search, onChange: setSearch, placeholder: 'Search infrastructure…' }}
            filters={filters}
          />
          <SortSelect
            options={sortOptions}
            value={sortField}
            direction={sortDir}
            onChange={(field, dir) => {
              setSortField(field)
              setSortDir(dir)
            }}
          />
        </div>

        <DataTable
          columns={columns}
          data={pageRows}
          rowKey={(row) => row.id}
          isLoading={isLoading}
          onRowClick={(row) => openDetail(row.id)}
          emptyState={{
            title: 'No BYOL infrastructure yet',
            description: 'Create a BYOL deployment to manage its topology, resources and lifecycle here.',
          }}
        />
        <div style={{ marginTop: 12 }}>
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={filteredSorted.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            pageSizeOptions={[10, 25, 50]}
          />
        </div>
      </CardBody>

      <FormDialog
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={editing ? `Edit "${editing.name}"` : 'New BYOL infrastructure'}
        description={dialogDescription}
        onSubmit={handleSubmit}
        submitText={editing ? 'Save changes' : 'Create infrastructure'}
        isSubmitting={submitting}
        submitDisabled={!form.name.trim() || (cloudAccountRequired && !form.cloudAccountConnectionId)}
        error={formError}
        size="md"
      >
        <FormBody
          form={form}
          setField={setField}
          setTierCount={setTierCount}
          setTierPlacement={setTierPlacement}
          topology={topo}
          onProviderChange={handleProviderChange}
          deploymentTypes={deploymentTypes}
          environmentOptions={environmentOptions}
          providerOptions={providerOptions}
          regionOptions={regionOptions}
          showRegion={showRegion}
          showCloudAccount={showCloudAccount}
          cloudAccountRequired={cloudAccountRequired}
          cloudAccountOptions={cloudAccountOptions}
          selectedProviderName={selectedProvider?.name}
          providerCode={selectedProvider?.code}
          versionOptions={versionOptions}
        />
      </FormDialog>
    </Card>
  )
}

// --- Create/edit form body (shared by both list + detail entry points) -------

interface FormBodyProps {
  form: FormState
  setField: <K extends keyof FormState>(key: K, value: FormState[K]) => void
  setTierCount: (key: string, value: string) => void
  setTierPlacement: (key: string, value: ClusterPlacement) => void
  /** The app's node topology — drives the tier count/placement fields and version-picker label. */
  topology: ByolTopology
  /** Provider-specific onChange (also clears a now-mismatched cloud account selection). */
  onProviderChange: (value: string) => void
  deploymentTypes: Array<{ value: string; label: string }>
  environmentOptions: Array<{ value: string; label: string }>
  providerOptions: Array<{ value: string; label: string }>
  regionOptions: Array<{ value: string; label: string }>
  showRegion: boolean
  /** Whether the current network mode is BYOC (dedicated/existing) and needs a cloud account. */
  showCloudAccount: boolean
  /** Whether an account MUST be picked (BYOC) vs optional (hosted platform account). */
  cloudAccountRequired: boolean
  /** Verified cloud accounts, narrowed to the selected provider when one is picked. */
  cloudAccountOptions: Array<{ value: string; label: string }>
  /** Selected cloud provider's display name, for the "no verified account" note. */
  selectedProviderName?: string
  /** Selected cloud provider's code (aws|azure|gcp|hetzner), for cloud-aware zone naming. */
  providerCode?: string
  /** Software version options (app-supplied); the picker is hidden when empty. */
  versionOptions: Array<{ value: string; label: string }>
}

/** A labelled sub-group of related fields, so the form reads as scannable sections. */
const FormSection: React.FC<{ title: string; description?: string; children: React.ReactNode }> = ({
  title,
  description,
  children,
}) => (
  <div>
    <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.text }}>{title}</p>
    {description ? (
      <p style={{ margin: '2px 0 0', fontSize: 12, color: tokens.muted }}>{description}</p>
    ) : null}
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
  </div>
)

const FormBody: React.FC<FormBodyProps> = ({
  form,
  setField,
  setTierCount,
  setTierPlacement,
  topology,
  onProviderChange,
  deploymentTypes,
  environmentOptions,
  providerOptions,
  regionOptions,
  showRegion,
  showCloudAccount,
  cloudAccountRequired,
  cloudAccountOptions,
  selectedProviderName,
  providerCode,
  versionOptions,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <Input label="Name" value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. Production cluster" fullWidth autoFocus />
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Select label="Deployment type" value={form.deploymentType} onChange={(value) => setField('deploymentType', value)} options={deploymentTypes} />
      <Select label="Environment" value={form.environmentType} onChange={(value) => setField('environmentType', value)} options={environmentOptions} />
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: showRegion ? '1fr 1fr' : '1fr', gap: 12 }}>
      <Select label="Provider" value={form.providerId} onChange={onProviderChange} options={providerOptions} />
      {showRegion ? (
        <Select label="Region" value={form.region} onChange={(value) => setField('region', value)} options={regionOptions} />
      ) : null}
    </div>

    <FormSection title="Deployment target">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Select
          label="Network"
          value={form.networkMode}
          onChange={(value) => setField('networkMode', value)}
          options={NETWORK_MODE_OPTIONS}
        />
        <Select label="DNS" value={form.dnsMode} onChange={(value) => setField('dnsMode', value)} options={DNS_MODE_OPTIONS} />
      </div>
      {showCloudAccount ? (
        <>
          <Select
            label={cloudAccountRequired ? 'Cloud account *' : 'Cloud account'}
            value={form.cloudAccountConnectionId}
            onChange={(value) => setField('cloudAccountConnectionId', value)}
            options={cloudAccountOptions}
            placeholder={
              cloudAccountOptions.length
                ? 'Select a verified cloud account…'
                : cloudAccountRequired
                  ? 'No verified cloud accounts'
                  : 'None — use the default provisioning identity'
            }
            disabled={cloudAccountOptions.length === 0}
            helperText={
              cloudAccountRequired
                ? 'Required for a dedicated or existing-network (BYOC) deployment.'
                : 'Optional — the Veltrix-managed account this hosted deployment provisions through.'
            }
          />
          {cloudAccountRequired && cloudAccountOptions.length === 0 ? (
            <Alert variant="warning" title="No verified cloud account available">
              {selectedProviderName
                ? `No verified ${selectedProviderName} cloud account found. Register and verify a cloud account first in Settings → Cloud Accounts.`
                : 'Register and verify a cloud account first in Settings → Cloud Accounts.'}
            </Alert>
          ) : null}
        </>
      ) : null}
    </FormSection>

    <FormSection
      title="Topology"
      description={
        form.deploymentType === 'distributed'
          ? `Distributed deployments need at least ${topology.tiers
              .map((t) => `${t.min ?? 1} ${(t.shortLabel ?? t.label).toLowerCase()}`)
              .join(' and ')}.`
          : 'Number of nodes to provision per tier.'
      }
    >
      {versionOptions.length > 0 ? (
        <Select
          label={topology.versionLabel ?? 'Version'}
          value={form.versionId}
          onChange={(value) => setField('versionId', value)}
          options={versionOptions}
          placeholder="Use the app's default version"
          helperText={`The ${topology.productName ?? 'software'} release installed on every node. Leave unset to use the app's default installer.`}
        />
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {topology.tiers.map((t) => (
          <Input
            key={t.key}
            label={t.label}
            helperText={t.help}
            type="number"
            min={1}
            value={form.tierCounts[t.key] ?? ''}
            onChange={(e) => setTierCount(t.key, e.target.value)}
            fullWidth
          />
        ))}
      </div>
      {form.providerId && form.providerId !== SELF_HOSTED ? (
        <Input
          label="Compute size (instance type)"
          value={form.instanceType}
          onChange={(e) => setField('instanceType', e.target.value)}
          placeholder={INSTANCE_TYPE_EXAMPLES.aws}
          fullWidth
          helperText={`Leave blank for the cloud default (~2 vCPU / 4 GB). Examples: AWS ${INSTANCE_TYPE_EXAMPLES.aws}, Azure ${INSTANCE_TYPE_EXAMPLES.azure}, GCP ${INSTANCE_TYPE_EXAMPLES.gcp}, Hetzner ${INSTANCE_TYPE_EXAMPLES.hetzner}. Applies to every node; you can change it here later.`}
        />
      ) : null}
      {showRegion
        ? topology.tiers
            .filter((t) => t.placeable !== false)
            .map((t) => (
              <ClusterPlacementField
                key={t.key}
                label={`${t.label} placement`}
                placement={form.tierPlacement[t.key] ?? { mode: 'single' }}
                nodeCount={Math.max(1, Number(form.tierCounts[t.key]) || 1)}
                primaryRegion={form.region}
                providerCode={providerCode}
                regionOptions={regionOptions}
                onChange={(p) => setTierPlacement(t.key, p)}
              />
            ))
        : null}
    </FormSection>

    {form.deploymentType === 'distributed' ? (
      <>
        <FormSection
          title="Control plane"
          description="How many instances the five management roles run on — fewer instances cut cost, more give isolation and HA."
        >
          <Select
            label="Consolidation"
            value={form.controlPlaneLayout}
            onChange={(value) => setField('controlPlaneLayout', value as FormState['controlPlaneLayout'])}
            options={CONTROL_PLANE_LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: `${o.label} — ${o.description}` }))}
          />
        </FormSection>

        <FormSection
          title="Ingest"
          description="Heavy forwarders for ingest routing. One is provisioned by default; add more for higher throughput."
        >
          <Input
            label="Heavy forwarders"
            type="number"
            min={1}
            value={form.heavyForwarderCount}
            onChange={(e) => setField('heavyForwarderCount', e.target.value)}
            fullWidth
          />
        </FormSection>
      </>
    ) : null}
  </div>
)

export default ByolInfrastructureManager
