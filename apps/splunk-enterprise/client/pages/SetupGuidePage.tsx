import React from 'react'
import { Badge, Button, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const COMPONENT_TYPES = ['indexer', 'search-head', 'cluster-manager']
const REST_DOCS_URL = 'https://docs.splunk.com/Documentation/Splunk/latest/RESTREF/RESTprolog'

/**
 * Step-by-step guide for connecting a Splunk Enterprise deployment, rendered
 * with the platform design-system components from @veltrixsecops/app-sdk/ui —
 * the same Tabs / Card / Badge / Button the built-in platform screens use.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'component',
      label: '1. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Add a component of a Splunk type. Set its hostname to the instance's{' '}
              <strong>management host</strong> and its port to <code>8089</code> — the Splunk
              management interface (splunkd REST API), not the web UI on 8000.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {COMPONENT_TYPES.map((type) => (
                <Badge key={type} variant="primary" size="sm">
                  {type}
                </Badge>
              ))}
            </div>
            <p>
              Choose the type that matches the instance's role — an <code>indexer</code> or{' '}
              <code>cluster-manager</code> for indexes and HEC tokens, a <code>search-head</code>{' '}
              or <code>cluster-manager</code> for roles.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Add a credential attached to the component's tool. Two schemes are supported:
            </p>
            <ul>
              <li>
                <strong>API token (preferred).</strong> Put a Splunk authentication token in the{' '}
                <em>API token</em> field — it is sent as a <code>Bearer</code> token on every
                request. Create one in Splunk under{' '}
                <em>Settings &gt; Tokens</em> (requires token authentication to be enabled).
              </li>
              <li>
                <strong>Username &amp; password.</strong> Put the Splunk username in the{' '}
                <em>username</em> field and the password in the <em>password</em> field for
                basic authentication.
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connectivity',
      label: '3. Connectivity',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Add a platform <strong>connectivity provider</strong> that can reach the Splunk
              management port (<code>8089</code>) on the component's host — for example a
              Tailscale, WireGuard, or ZeroTier tunnel into the network where Splunk runs. The
              pipeline routes deploy, health check, and drift-detection requests through it.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'deploy',
      label: '4. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create a configuration in the Configuration Canvas (indexes, roles, or HEC tokens)
              and run it through the pipeline. Validation, health checks, drift detection, and
              rollback are handled per configuration type.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(REST_DOCS_URL, '_blank', 'noopener')}
            >
              Splunk REST API reference
            </Button>
          </CardBody>
        </Card>
      ),
    },
  ]

  return (
    <div>
      <h2>Splunk Enterprise — Setup Guide</h2>
      <Tabs tabs={tabs} />
    </div>
  )
}
