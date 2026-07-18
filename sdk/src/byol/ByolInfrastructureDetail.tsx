import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spinner, useConfirmDialog } from '../ui'
import { buildByolResourcePlan } from './topology'
import { isRunning, isNotStarted } from './status'
import {
  getInfra,
  getResources,
  getDeployments,
  getPlan,
  deployInfra,
  destroyInfra,
  lifecycleInfra,
  errorText,
  formatDate,
} from './api'
import type { ByolInfrastructure, ByolResource, ByolDeployment, ByolConfigLink } from './types'
import { SELF_HOSTED_LABEL } from './types'
import type { ByolPlan } from './diffPlan'
import { tokens, StatusPill, Meta, ProgressMeter } from './detail/shared'
import { OverviewTab } from './detail/OverviewTab'
import { ResourcesTab } from './detail/ResourcesTab'
import { ActivityTab } from './detail/ActivityTab'
import { AccessTab } from './detail/AccessTab'
import { ConfigurationTab } from './detail/ConfigurationTab'
import { SettingsTab } from './detail/SettingsTab'
import { ByolPlanModal } from './detail/ByolPlanModal'
import { DestroyPlanModal } from './detail/DestroyPlanModal'
import {
  OverviewIcon,
  ResourcesIcon,
  ActivityIcon,
  AccessIcon,
  ConfigurationIcon,
  SettingsIcon,
  type IconProps,
} from './detail/icons'

/** How often the detail view re-polls while a deployment is in flight. */
const PROVISIONING_POLL_MS = 4000

type Section = 'overview' | 'resources' | 'activity' | 'access' | 'config' | 'settings'

// Inline-SVG icons (font-independent) rather than Unicode glyphs, which failed
// to render in the platform shell font — see detail/icons.tsx.
const SECTIONS: Array<{ key: Section; label: string; Icon: React.FC<IconProps> }> = [
  { key: 'overview', label: 'Overview', Icon: OverviewIcon },
  { key: 'resources', label: 'Resources', Icon: ResourcesIcon },
  { key: 'activity', label: 'Activity', Icon: ActivityIcon },
  { key: 'access', label: 'Access', Icon: AccessIcon },
  { key: 'config', label: 'Configuration', Icon: ConfigurationIcon },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon },
]

export interface ByolInfrastructureDetailProps {
  apiBase: string
  /** The row the user clicked — rendered instantly, then refreshed from the API. */
  initialInfra: ByolInfrastructure
  configBase?: string
  configLinks?: ByolConfigLink[]
  onBack: () => void
  onEdit: (infra: ByolInfrastructure) => void
  onDeleted: () => void
  /** Called after any mutation so the parent list can refresh statuses. */
  onChanged: () => void
  /** Bumped by the parent (e.g. after an edit via the shared form) to force a reload. */
  reloadSignal?: number
}

/** Derive pseudo-resources from topology for the pre-deploy plan view. */
function derivePlan(infra: ByolInfrastructure): ByolResource[] {
  const plan = buildByolResourcePlan({
    deploymentType: infra.deploymentType,
    indexerCount: infra.indexerCount,
    searchHeadCount: infra.searchHeadCount,
    hostingType: infra.hosting_type,
    isCloud: Boolean(infra.cloudProviderId),
    region: infra.region ?? null,
    indexerRegions: (infra.indexerRegions ?? []).map((r) => r.region),
    searchHeadRegions: (infra.searchHeadRegions ?? []).map((r) => r.region),
  })
  return plan.map((p) => ({
    id: p.planKey,
    infrastructureId: infra.id,
    tier: p.tier,
    kind: p.kind,
    name: p.name,
    role: p.role,
    region: p.region,
    status: 'not_started',
    externalRef: null,
    message: null,
    planKey: p.planKey,
    sortOrder: p.sortOrder,
  }))
}

function readSectionFromUrl(): Section | null {
  if (typeof window === 'undefined') return null
  const s = new URLSearchParams(window.location.search).get('section')
  return SECTIONS.some((x) => x.key === s) ? (s as Section) : null
}

export const ByolInfrastructureDetail: React.FC<ByolInfrastructureDetailProps> = ({
  apiBase,
  initialInfra,
  configBase,
  configLinks,
  onBack,
  onEdit,
  onDeleted,
  onChanged,
  reloadSignal = 0,
}) => {
  const [infra, setInfra] = useState<ByolInfrastructure>(initialInfra)
  const [resources, setResources] = useState<ByolResource[]>([])
  const [deployments, setDeployments] = useState<ByolDeployment[]>([])
  const [section, setSection] = useState<Section>(readSectionFromUrl() ?? 'overview')
  const [collapsed, setCollapsed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // --- Plan → Apply modal state ---
  const [planOpen, setPlanOpen] = useState(false)
  const [plan, setPlan] = useState<ByolPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  // --- Destroy plan modal state ---
  // Mirrors the Plan → Apply flow above: "Destroy infrastructure" opens a modal
  // that previews exactly what will be torn down (every current resource, as a
  // destroy plan) rather than a generic yes/no text confirmation.
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [destroyResources, setDestroyResources] = useState<ByolResource[] | null>(null)
  const [destroyLoading, setDestroyLoading] = useState(false)
  const [destroyError, setDestroyError] = useState<string | null>(null)
  const [destroying, setDestroying] = useState(false)

  // Danger-zone confirmation for Delete — the platform's real confirmation dialog
  // (portaled to document.body, themed via the host's brand tokens) when running
  // inside Veltrix; fails closed (no destructive action proceeds) outside it.
  // Replaces the native window.confirm() this view used to call directly. Destroy
  // uses the richer DestroyPlanModal below instead of this text confirmation.
  const { confirm } = useConfirmDialog()

  const id = initialInfra.id

  // Keep the latest list row available as a fallback without churning `load`.
  const initialRef = useRef(initialInfra)
  initialRef.current = initialInfra

  const load = useCallback(async () => {
    setError(null)
    try {
      const [freshInfra, res, deps] = await Promise.all([
        getInfra(apiBase, id).catch(() => initialRef.current),
        getResources(apiBase, id).catch(() => [] as ByolResource[]),
        getDeployments(apiBase, id).catch(() => [] as ByolDeployment[]),
      ])
      setInfra(freshInfra)
      setResources(res)
      setDeployments(deps)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [apiBase, id])

  useEffect(() => {
    void load()
    // reloadSignal is an explicit parent-driven refresh trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, reloadSignal])

  // Reflect the open detail + section in the URL for refresh / deep-link.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    params.set('infra', id)
    params.set('section', section)
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
  }, [id, section])

  const refresh = useCallback(async () => {
    await load()
    onChanged()
  }, [load, onChanged])

  // While a deployment (or teardown) is in flight, re-poll so the persisted
  // resource/step rows — and thus the ProgressMeter — animate toward terminal
  // state without the user having to hit Refresh. Cleared on unmount or as soon
  // as the status leaves the transient state.
  const transient = infra.status === 'provisioning' || infra.status === 'destroying'
  useEffect(() => {
    if (!transient) return
    let active = true
    const timer = setInterval(() => {
      if (active) void refresh()
    }, PROVISIONING_POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [transient, refresh])

  const runAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await fn()
        await refresh()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  // Deploy is now a two-phase flow: open the plan modal and fetch the dry-run
  // diff (spinner in the modal); Apply is what actually POSTs /deploy.
  const openPlan = useCallback(() => {
    setPlanOpen(true)
    setPlan(null)
    setPlanError(null)
    setPlanLoading(true)
    getPlan(apiBase, id)
      .then((p) => setPlan(p))
      .catch((e) => setPlanError((e as Error).message))
      .finally(() => setPlanLoading(false))
  }, [apiBase, id])

  const closePlan = useCallback(() => {
    if (applying) return
    setPlanOpen(false)
  }, [applying])

  const onApply = useCallback(async () => {
    setApplying(true)
    setPlanError(null)
    try {
      await deployInfra(apiBase, id)
      setPlanOpen(false)
      setSection('activity')
      await refresh()
    } catch (e) {
      setPlanError((e as Error).message)
    } finally {
      setApplying(false)
    }
  }, [apiBase, id, refresh])

  // Destroy is a two-phase flow, mirroring Deploy: open the destroy-plan modal
  // (a fresh resource fetch so the preview reflects reality even if `resources`
  // is stale), and only POST /destroy when the user confirms inside the modal.
  const openDestroy = useCallback(() => {
    setDestroyOpen(true)
    setDestroyError(null)
    setDestroyResources(null)
    setDestroyLoading(true)
    getResources(apiBase, id)
      .then((res) => setDestroyResources(res))
      // A failed refetch must never block Destroy — fall back to whatever the
      // detail view already has loaded (possibly empty; the modal handles that).
      .catch(() => setDestroyResources(resources))
      .finally(() => setDestroyLoading(false))
  }, [apiBase, id, resources])

  const closeDestroy = useCallback(() => {
    if (destroying) return
    setDestroyOpen(false)
  }, [destroying])

  const confirmDestroy = useCallback(async () => {
    setDestroying(true)
    setDestroyError(null)
    try {
      await destroyInfra(apiBase, id)
      setDestroyOpen(false)
      setSection('activity')
      await refresh()
    } catch (e) {
      setDestroyError((e as Error).message)
    } finally {
      setDestroying(false)
    }
  }, [apiBase, id, refresh])

  const onLifecycle = (action: 'start' | 'stop' | 'restart') => runAction(() => lifecycleInfra(apiBase, id, action))
  const onDelete = async () => {
    const ok = await confirm({
      title: 'Delete infrastructure record',
      message: `Delete "${infra.name}"? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const res = await import('../client').then(({ authFetch }) => authFetch(`${apiBase}/${id}`, { method: 'DELETE' }))
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res))
      onDeleted()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const status = infra.status
  const notStarted = isNotStarted(status)
  const failed = status === 'failed' || status === 'error'
  const provisioning = status === 'provisioning' || status === 'destroying'
  const running = isRunning(status)
  // A torn-down environment can be stood up again — re-provisioning re-runs the plan
  // against the now-empty state (resources were reset to not_started on teardown).
  const deprovisioned = status === 'deprovisioned' || status === 'decommissioned'

  // `deployments` is ordered newest-first (see `listDeployments` — ORDER BY
  // started_at DESC), so [0] is the run that produced the current failed
  // status. A failed *destroy* must retry the teardown, not re-provision —
  // defaults to the deploy retry path when no runs have loaded yet.
  const latestRunAction = deployments[0]?.action
  const failedDestroy = failed && latestRunAction === 'destroy'

  // Persisted plan when it exists; otherwise the derived plan (pre-deploy).
  const derived = resources.length === 0
  const displayResources = useMemo(
    () => (derived ? derivePlan(infra) : resources),
    [derived, infra, resources],
  )

  const provider = infra.hosting_type || (infra.cloudProviderId ? 'Cloud' : SELF_HOSTED_LABEL)

  const primaryAction = (() => {
    if (notStarted) return <Button variant="primary" size="sm" onClick={openPlan} disabled={busy}>Deploy environment</Button>
    if (deprovisioned) return <Button variant="primary" size="sm" onClick={openPlan} disabled={busy}>Re-provision</Button>
    if (failedDestroy) return <Button variant="danger" size="sm" onClick={openDestroy} disabled={busy}>Retry Destroy</Button>
    if (failed) return <Button variant="primary" size="sm" onClick={openPlan} disabled={busy}>Retry deployment</Button>
    if (provisioning) return <Button variant="primary" size="sm" onClick={() => setSection('activity')}>View progress</Button>
    return null
  })()

  const content = (() => {
    switch (section) {
      case 'overview':
        return <OverviewTab infra={infra} resources={displayResources} />
      case 'resources':
        return <ResourcesTab resources={displayResources} derived={derived} />
      case 'activity':
        return <ActivityTab deployments={deployments} />
      case 'access':
        return <AccessTab infra={infra} resources={resources} />
      case 'config':
        return <ConfigurationTab links={configLinks ?? []} configBase={configBase} />
      case 'settings':
        return (
          <SettingsTab
            infra={infra}
            busy={busy}
            onEdit={() => onEdit(infra)}
            onDestroy={openDestroy}
            onDelete={onDelete}
          />
        )
    }
  })()

  return (
    <div>
      <button
        onClick={onBack}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          color: tokens.muted,
          fontSize: 13,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          marginBottom: 12,
        }}
      >
        ‹ Back to infrastructure
      </button>

      <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 12, background: tokens.surface, overflow: 'hidden' }}>
        {/* summary header */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px 24px', alignItems: 'flex-start', justifyContent: 'space-between', padding: 20 }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 21, letterSpacing: '-.01em', color: tokens.text }}>{infra.name}</h2>
              <StatusPill status={status} />
              {loading ? <Spinner size="sm" /> : null}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 20px', marginTop: 12 }}>
              <Meta label="Environment">{infra.environmentType || '—'}</Meta>
              <Meta label="Deployment">{infra.deploymentType ?? '—'}</Meta>
              <Meta label="Provider">{provider}</Meta>
              <Meta label="Region">{infra.region || '—'}</Meta>
              <Meta label="Updated">{formatDate(infra.updatedAt)}</Meta>
            </div>
            <div style={{ marginTop: 14 }}>
              <ProgressMeter resources={displayResources} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
            {primaryAction}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {running ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => onLifecycle('stop')} disabled={busy}>Stop</Button>
                  <Button variant="ghost" size="sm" onClick={() => onLifecycle('restart')} disabled={busy}>Restart</Button>
                </>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => onEdit(infra)} disabled={busy}>Edit topology</Button>
              <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy}>Refresh</Button>
            </div>
          </div>
        </div>

        {error ? (
          <div style={{ padding: '0 20px 12px', color: tokens.danger, fontSize: 13 }}>{error}</div>
        ) : null}

        {/* secondary expandable sidebar + content */}
        <div style={{ display: 'flex', borderTop: `1px solid ${tokens.border}`, alignItems: 'stretch' }}>
          <aside
            style={{
              flex: `0 0 ${collapsed ? 56 : 220}px`,
              width: collapsed ? 56 : 220,
              borderRight: `1px solid ${tokens.border}`,
              background: tokens.surface2,
              padding: '14px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              transition: 'flex-basis .12s, width .12s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between', padding: '2px 6px 10px' }}>
              {collapsed ? null : (
                <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: tokens.faint, fontWeight: 700 }}>
                  This infrastructure
                </span>
              )}
              <button
                onClick={() => setCollapsed((c) => !c)}
                title={collapsed ? 'Expand' : 'Collapse'}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                style={{
                  border: `1px solid ${tokens.border}`,
                  background: tokens.surface,
                  color: tokens.muted,
                  borderRadius: 6,
                  width: 24,
                  height: 24,
                  cursor: 'pointer',
                  lineHeight: 1,
                }}
              >
                {collapsed ? '»' : '«'}
              </button>
            </div>
            {SECTIONS.map((s) => {
              const active = s.key === section
              const { Icon } = s
              return (
                <button
                  key={s.key}
                  onClick={() => setSection(s.key)}
                  title={s.label}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    gap: 11,
                    padding: collapsed ? '9px 0' : '9px 10px',
                    borderRadius: 8,
                    border: 'none',
                    background: active ? tokens.surface : 'transparent',
                    color: active ? tokens.primary : tokens.muted,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%',
                  }}
                >
                  {active ? (
                    <span style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: '0 3px 3px 0', background: tokens.primary }} />
                  ) : null}
                  <span style={{ width: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                    <Icon size={16} />
                  </span>
                  {collapsed ? null : <span style={{ flex: 1 }}>{s.label}</span>}
                  {!collapsed && s.key === 'resources' && displayResources.length > 0 ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: tokens.faint }}>{displayResources.length}</span>
                  ) : null}
                  {!collapsed && s.key === 'activity' && provisioning ? (
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: tokens.info }} />
                  ) : null}
                </button>
              )
            })}
          </aside>

          <div style={{ flex: 1, minWidth: 0, padding: '22px 24px' }}>{content}</div>
        </div>
      </div>

      <ByolPlanModal
        isOpen={planOpen}
        onClose={closePlan}
        plan={plan}
        loading={planLoading}
        error={planError}
        applying={applying}
        onApply={onApply}
        infraName={infra.name}
        allowApplyWithoutChanges={infra.status === 'failed' || infra.status === 'error' || infra.status === 'not_started'}
      />

      <DestroyPlanModal
        isOpen={destroyOpen}
        onClose={closeDestroy}
        resources={destroyResources}
        loading={destroyLoading}
        error={destroyError}
        destroying={destroying}
        onConfirm={confirmDestroy}
        infraName={infra.name}
      />
    </div>
  )
}

export default ByolInfrastructureDetail
