import React, { useMemo, useState } from 'react'
import type { InventoryItem } from '@veltrixsecops/app-sdk'
import { Button, Checkbox, Modal, Select } from '@veltrixsecops/app-sdk/ui'
import { requestRun, type PolicyWithAccounts, type RunResult } from './api'
import { ActionClassBadge, EnforcementBadge } from './RunBadges'
import { canEnforce } from './labels'
import { MUTED, ROW } from './styles'
import { AlertIcon, PlayIcon } from './icons'

interface Props {
  policy: PolicyWithAccounts
  accounts: InventoryItem[]
  onClose: () => void
  onRequested: (result: RunResult) => void
}

type Kind = 'preview' | 'enforce'

export function RunRequestDialog({ policy, accounts, onClose, onRequested }: Props) {
  const options = useMemo(
    () =>
      policy.accounts.map((pa) => {
        const inv = accounts.find((a) => a.id === pa.componentId)
        return { value: pa.componentId, label: inv?.hostname || pa.accountRef || pa.componentId }
      }),
    [policy.accounts, accounts],
  )
  const [componentId, setComponentId] = useState(options[0]?.value ?? '')
  const [kind, setKind] = useState<Kind>('preview')
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enforceAllowed = canEnforce(policy.enforcement)
  const irreversible = kind === 'enforce' && policy.actionClass === 'irreversible'
  const blocked = !componentId || (irreversible && !acknowledged)

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const enforcement = kind === 'enforce' && (policy.enforcement === 'ask' || policy.enforcement === 'auto') ? policy.enforcement : undefined
      onRequested(await requestRun(policy.id, { componentId, kind, enforcement }))
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title={kind === 'preview' ? 'Preview run' : 'Enforce policy'}
      subtitle={policy.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            variant={kind === 'enforce' && policy.actionClass !== 'none' ? 'danger' : 'primary'}
            leftIcon={<PlayIcon />}
            isLoading={submitting}
            disabled={blocked}
            onClick={submit}
          >
            {kind === 'preview' ? 'Start preview' : 'Enforce now'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={ROW}>
          <EnforcementBadge value={policy.enforcement} />
          <ActionClassBadge value={policy.actionClass} />
        </div>
        {options.length === 0 ? (
          <p style={MUTED}>This policy is not attached to any account yet. Attach an account in the policy configuration first.</p>
        ) : (
          <Select label="Account" options={options} value={componentId} onChange={setComponentId} fullWidth />
        )}
        {enforceAllowed && (
          <Select
            label="Run type"
            value={kind}
            onChange={(v) => { setKind(v as Kind); setAcknowledged(false) }}
            options={[
              { value: 'preview', label: 'Preview (no changes)' },
              { value: 'enforce', label: 'Enforce (applies changes)' },
            ]}
            fullWidth
          />
        )}
        {kind === 'preview' && <p style={MUTED}>A preview evaluates the policy and lists matching resources. Nothing is changed.</p>}
        {irreversible && (
          <div role="alert" style={{ ...ROW, alignItems: 'flex-start', color: 'rgb(var(--color-danger))' }}>
            <AlertIcon />
            <div style={{ flex: 1 }}>
              <strong>This policy makes irreversible changes.</strong>
              <Checkbox label="I reviewed a preview and understand this cannot be undone." checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            </div>
          </div>
        )}
        {error && <p role="alert" style={{ color: 'rgb(var(--color-danger))', margin: 0 }}>{error}</p>}
      </div>
    </Modal>
  )
}
