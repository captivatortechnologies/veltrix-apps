import React, { useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
} from '@veltrixsecops/app-sdk/ui'

interface ConfigTypeSummary {
  id: string
  name: string
  description?: string
  componentTypes: string[]
}

interface AppMeta {
  appId: string
  name: string
  version: string
  configurationTypes: ConfigTypeSummary[]
}

/**
 * Home/overview for the Splunk Cloud Platform app. Summarizes what the app
 * manages on a Splunk Cloud stack via the Admin Config Service (ACS) API.
 * Rendered with the platform design-system components from
 * @veltrixsecops/app-sdk/ui so it matches the platform look and picks up the
 * app's Splunk brand color. Authoring/editing happens in the Configuration
 * Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // App routes are bearer-token protected — authFetch attaches the header
    authFetch('/api/apps/splunk-cloud/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Splunk Cloud app details…" />
  if (error) {
    return <EmptyState title="Failed to load app details" description={error} />
  }
  if (!meta) return <EmptyState title="No app details available" />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <CardHeader actions={<Badge variant="primary">v{meta.version}</Badge>}>
          <h2 style={{ margin: 0 }}>{meta.name}</h2>
        </CardHeader>
        <CardBody>
          <p>
            Manage Splunk Cloud Platform configuration as code through the Admin Config Service
            (ACS) API. Author a configuration in the Configuration Canvas and deploy it through the
            pipeline — validate, deploy, health check, drift detection, and rollback are all handled
            per configuration type.
          </p>
          <p>
            New here? Open the <strong>Setup Guide</strong> to register your stack, create an ACS
            token, and connect the credential.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 style={{ margin: 0 }}>Configuration Types</h3>
        </CardHeader>
        <CardBody>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {meta.configurationTypes.map((ct) => (
              <Card key={ct.id} variant="bordered" padding="md">
                <CardBody>
                  <strong>{ct.name}</strong>
                  {ct.description ? <p>{ct.description}</p> : null}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {ct.componentTypes.map((type) => (
                      <Badge key={type} variant="secondary" size="sm">
                        {type}
                      </Badge>
                    ))}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
