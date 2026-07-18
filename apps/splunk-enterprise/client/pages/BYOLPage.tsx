import React, { useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Splunk Enterprise — BYOL infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Splunk-specific configuration links — and the Splunk
 * version catalog options for the form's "Splunk version" picker — are
 * supplied here, keeping the SDK app-agnostic.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'apps', title: 'Splunk Apps', description: 'Install apps & add-ons and the .conf files they ship (indexes, roles).', configTypeId: 'apps' },
  { key: 'hec-tokens', title: 'HEC Tokens', description: 'Create HTTP Event Collector tokens, routing and allowed indexes.', configTypeId: 'hec-tokens' },
]

const VERSIONS_API = '/api/apps/splunk-enterprise/versions'

interface SplunkVersionSummary {
  id: string
  version: string
  isActive?: boolean
  isLatest?: boolean
}

export default function BYOLPage() {
  const [versionOptions, setVersionOptions] = useState<Array<{ value: string; label: string }>>([])
  const [defaultVersionId, setDefaultVersionId] = useState<string | undefined>(undefined)

  // Best-effort: a permission gap or transient failure just hides the picker
  // (the SDK form already treats an empty versionOptions list as "no picker"),
  // it never blocks the BYOL page from loading.
  useEffect(() => {
    let cancelled = false
    authFetch(VERSIONS_API)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: SplunkVersionSummary[]) => {
        if (cancelled) return
        const versions = Array.isArray(data) ? data : []
        const active = versions.filter((v) => v.isActive)
        setVersionOptions(active.map((v) => ({ value: v.id, label: `${v.version}${v.isLatest ? ' · latest' : ''}` })))
        setDefaultVersionId(active.find((v) => v.isLatest)?.id)
      })
      .catch(() => {
        if (cancelled) return
        setVersionOptions([])
        setDefaultVersionId(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/splunk-enterprise/byol"
      title="BYOL Splunk Infrastructure"
      configBase="/apps/splunk-enterprise/config"
      configLinks={CONFIG_LINKS}
      versionOptions={versionOptions}
      defaultVersionId={defaultVersionId}
    />
  )
}
