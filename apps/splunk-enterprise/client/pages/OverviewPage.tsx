import React, { useEffect, useState } from 'react'
import { CONFIGURATION_AREAS } from '../lib/capabilities'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Spinner,
  StatsCard,
} from '@veltrixsecops/app-sdk/ui'

interface SplunkVersion {
  id: string
  version: string
  isActive?: boolean
  isLatest?: boolean
}

interface ManagedArea {
  name: string
  description: string
  componentTypes: string[]
}

// What this app manages in a Splunk Enterprise deployment. Mirrors the
// configuration types + client pages, grouped for the overview at a glance.
const MANAGED_AREAS: ManagedArea[] = [
  ...CONFIGURATION_AREAS.map(area => ({ ...area, componentTypes: [...area.componentTypes] })),
  { name: 'BYOL Infrastructure', description: 'Provision and track infrastructure through configured platform workers; plan upgrades and manage version records.', componentTypes: ['indexer', 'search-head', 'cluster-manager'] },
  { name: 'License Records', description: 'Record license XML and inspect live licensing status. Recording a file does not install it on Splunk.', componentTypes: ['license-server'] },
]

/**
 * Home/overview for the Splunk Enterprise app. Summarizes what the app manages
 * and surfaces a quick health signal (tracked release lines) by calling the
 * read-only GET /versions route. Rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui so it matches the platform look.
 * Authoring/editing happens in the platform's Configuration Canvas.
 */
export default function OverviewPage() {
  const [versions, setVersions] = useState<SplunkVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // App routes are bearer-token protected — authFetch attaches the header
    authFetch('/api/apps/splunk-enterprise/versions')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: SplunkVersion[]) => setVersions(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const latest = versions?.find((v) => v.isLatest)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <CardBody>
          <p>
            Manage Splunk Enterprise configuration as code through the Splunk management API
            (REST, port 8089). Author a configuration in the Configuration Canvas and deploy it
            through the pipeline — validate, deploy, health check, drift detection, and rollback
            are all handled per configuration type.
          </p>
          <p>
            New here? Open the <strong>Setup Guide</strong> to connect a Splunk component,
            credential, and a reachable management endpoint.
          </p>
        </CardBody>
      </Card>

      <div
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        }}
      >
        <StatsCard label="Configuration types" value={CONFIGURATION_AREAS.length} variant="primary" />
        <StatsCard
          label="Tracked release lines"
          value={loading ? '—' : (versions?.length ?? 0)}
          isLoading={loading}
        />
        <StatsCard label="Latest release" value={loading ? '—' : (latest?.version ?? '—')} />
      </div>

      {error ? (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p role="alert">Could not load the version catalog: {error}</p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <h3 style={{ margin: 0 }}>What this app manages</h3>
        </CardHeader>
        <CardBody>
          {loading ? (
            <Spinner label="Loading Splunk Enterprise app details…" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {MANAGED_AREAS.map((area) => (
                <Card key={area.name} variant="bordered" padding="md">
                  <CardBody>
                    <strong>{area.name}</strong>
                    <p>{area.description}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {area.componentTypes.map((type) => (
                        <Badge key={type} variant="secondary" size="sm">
                          {type}
                        </Badge>
                      ))}
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
