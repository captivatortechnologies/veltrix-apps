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

interface AppStatus {
  status: string
  appId: string
}

/**
 * Overview of the Splunk SOAR connection app, rendered with the platform
 * design-system components from @veltrixsecops/app-sdk/ui so the page matches
 * the platform look and picks up the app's brand color. It confirms the app's
 * server routes are reachable (GET /api/apps/splunk-soar/status) and explains
 * what the app manages. Authoring/editing happens in the Configuration Canvas.
 */
export default function OverviewPage() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // App routes are bearer-token protected — authFetch attaches the header
    authFetch('/api/apps/splunk-soar/status')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setStatus)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Splunk SOAR app details…" />
  if (error) {
    return <EmptyState title="Failed to load app details" description={error} />
  }

  const online = status?.status === 'ok'

  return (
    <Card>
      <CardHeader
        actions={
          <Badge variant={online ? 'primary' : 'secondary'}>
            {online ? 'Connected' : 'Unknown'}
          </Badge>
        }
      >
        <h2>Splunk SOAR</h2>
      </CardHeader>
      <CardBody>
        <p>
          Manages the connection between Veltrix and your Splunk SOAR (Security
          Orchestration, Automation and Response) deployment. The connection profile is how the
          platform reaches SOAR — endpoint reachability, TLS verification, request timeout, and
          retries — so pipeline handlers can validate, deploy, health-check, and detect drift on
          the connection.
        </p>

        <h3>Configuration Types</h3>
        <Card variant="bordered" padding="md">
          <CardBody>
            <strong>SOAR Connection</strong>
            <p>
              Splunk SOAR instance connection profile (endpoint reachability, TLS, timeout,
              retries, proxy). Create one in the Configuration Canvas and run it through the
              pipeline.
            </p>
            <div>
              <Badge variant="secondary" size="sm">
                soar-instance
              </Badge>
            </div>
          </CardBody>
        </Card>
      </CardBody>
    </Card>
  )
}
