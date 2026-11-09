import React, { useMemo, useState } from 'react'
import { Button, Card, CardBody, CardHeader, DataTable, EmptyState, StatsCard, type DataTableColumn } from '@veltrixsecops/app-sdk/ui'
import { api, listAwsAccounts, useLoad, type PolicyWithAccounts, type RunDto, type RunResult } from '../lib/api'
import { ActionClassBadge, EnforcementBadge, RunStatusPill } from '../lib/RunBadges'
import { RunRequestDialog } from '../lib/RunRequestDialog'
import { RunDetailPanel } from '../lib/RunDetailPanel'
import { LoopPanel } from '../lib/LoopPanel'
import { ArrowRightIcon, PlayIcon } from '../lib/icons'
import { formatTime } from '../lib/labels'
import { GRID, MUTED, PAGE } from '../lib/styles'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const POLICIES_PATH = '/apps/cloud-governance/config/policies'
const ACCOUNTS_PATH = '/apps/cloud-governance/connections'

interface Overview {
  policies: PolicyWithAccounts[]
  runs: RunDto[]
}

const loadOverview = async (): Promise<Overview> => {
  const [policies, runs] = await Promise.all([api<PolicyWithAccounts[]>('/policies'), api<RunDto[]>('/runs?limit=200')])
  return { policies, runs }
}

const LinkButton = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} style={{ textDecoration: 'none' }}>
    <Button tabIndex={-1} rightIcon={<ArrowRightIcon />}>{children}</Button>
  </a>
)

export default function OverviewPage() {
  const overview = useLoad(loadOverview, [])
  const accounts = useLoad(listAwsAccounts, [])
  const [requesting, setRequesting] = useState<PolicyWithAccounts | null>(null)
  const [opened, setOpened] = useState<RunResult | null>(null)

  const { policies, runs } = overview.data ?? { policies: [], runs: [] }

  const lastRunByPolicy = useMemo(() => {
    const map = new Map<string, RunDto>()
    for (const run of runs) if (!map.has(run.policyId)) map.set(run.policyId, run)
    return map
  }, [runs])

  const stats = useMemo(() => {
    const cutoff = Date.now() - WEEK_MS
    const latestPreview = new Map<string, RunDto>()
    for (const run of runs) {
      if (run.kind === 'preview' && run.status === 'succeeded' && !latestPreview.has(run.policyId)) latestPreview.set(run.policyId, run)
    }
    return {
      compiled: policies.filter((p) => p.compiledYaml).length,
      recentRuns: runs.filter((r) => new Date(r.createdAt).getTime() >= cutoff).length,
      matched: [...latestPreview.values()].reduce((sum, r) => sum + (r.counts.matched ?? 0), 0),
    }
  }, [policies, runs])

  const columns: DataTableColumn<PolicyWithAccounts>[] = [
    { key: 'name', header: 'Policy', render: (p) => <strong>{p.name}</strong> },
    { key: 'resource', header: 'Resource', render: (p) => p.model.resource },
    { key: 'enforcement', header: 'Enforcement', render: (p) => <EnforcementBadge value={p.enforcement} /> },
    { key: 'actionClass', header: 'Action class', render: (p) => <ActionClassBadge value={p.actionClass} /> },
    { key: 'accounts', header: 'Accounts', align: 'right', render: (p) => p.accounts.length },
    {
      key: 'lastRun',
      header: 'Last run',
      render: (p) => {
        const run = lastRunByPolicy.get(p.id)
        if (!run) return <span style={MUTED}>Never run</span>
        return (
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <RunStatusPill status={run.status} />
            <span style={MUTED}>{formatTime(run.createdAt)}</span>
          </span>
        )
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (p) => (
        <Button size="sm" variant="secondary" leftIcon={<PlayIcon />} onClick={() => setRequesting(p)} aria-label={`Preview run for ${p.name}`}>
          Preview run
        </Button>
      ),
    },
  ]

  const noPolicies = !overview.loading && !overview.error && policies.length === 0
  const noAccounts = !accounts.loading && !accounts.error && (accounts.data?.length ?? 0) === 0

  return (
    <div style={PAGE}>
      <LoopPanel />

      <div style={GRID}>
        <StatsCard label="Policies" value={policies.length} isLoading={overview.loading} />
        <StatsCard label="Compiled" value={stats.compiled} isLoading={overview.loading} variant="primary" />
        <StatsCard label="Accounts connected" value={accounts.data?.length ?? 0} isLoading={accounts.loading} variant={noAccounts ? 'warning' : 'success'} />
        <StatsCard label="Runs in last 7 days" value={stats.recentRuns} isLoading={overview.loading} />
        <StatsCard label="Matched in latest previews" value={stats.matched} isLoading={overview.loading} variant={stats.matched ? 'warning' : 'default'} />
      </div>

      {overview.error && (
        <EmptyState title="Could not load policies" description={overview.error} action={<Button variant="secondary" onClick={() => void overview.reload()}>Retry</Button>} />
      )}

      {noAccounts && (
        <EmptyState
          title="No AWS accounts connected"
          description="Connect an AWS account so previews and enforcement runs have somewhere to execute."
          action={<LinkButton href={ACCOUNTS_PATH}>Connect an account</LinkButton>}
        />
      )}

      {noPolicies && (
        <EmptyState
          title="No policies yet"
          description="Author governance policies in the Policies configuration type, compile them, then preview them here."
          action={<LinkButton href={POLICIES_PATH}>Open Policies</LinkButton>}
        />
      )}

      {!noPolicies && !overview.error && (
        <Card>
          <CardHeader>Policies</CardHeader>
          <CardBody>
            <DataTable columns={columns} data={policies} rowKey={(p) => p.id} isLoading={overview.loading} emptyState={{ title: 'No policies' }} />
          </CardBody>
        </Card>
      )}

      {requesting && (
        <RunRequestDialog
          policy={requesting}
          accounts={accounts.data ?? []}
          onClose={() => setRequesting(null)}
          onRequested={(result) => {
            setRequesting(null)
            setOpened(result)
            void overview.reload()
          }}
        />
      )}
      {opened && (
        <RunDetailPanel runId={opened.run.id} dispatchPending={opened.dispatchPending} onClose={() => setOpened(null)} onChanged={() => void overview.reload()} />
      )}
    </div>
  )
}
