import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

// Endpoints the REST API v2 token must be granted (Read + Write).
const ENDPOINTS = ['/api/v2/policy/urllist', '/api/v2/policy/urllist/deploy']

/**
 * Step-by-step connection guide for the Netskope app, rendered with the platform
 * design-system components from @veltrixsecops/app-sdk/ui — the same Tabs / Card
 * / Badge the built-in platform screens use, themed to the app's brand color.
 * Netskope authenticates with a REST API v2 token.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Netskope admin console, go to <strong>Settings &gt; Tools &gt; REST API v2</strong>{' '}
              and create a <strong>New Token</strong>. Grant it these endpoints with{' '}
              <strong>Read + Write</strong> privilege:
            </p>
            <div>
              {ENDPOINTS.map((e) => (
                <Badge key={e} variant="primary" size="sm">
                  {e}
                </Badge>
              ))}
            </div>
            <p>Copy the token value — Netskope shows it only once.</p>
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
            <p>Store the token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Password</strong> → the REST API v2 token
              </li>
            </ul>
            <p>
              The app sends it on every request as the <code>Netskope-Api-Token</code> header. Set the
              app's <strong>Tenant</strong> setting to your tenant host (e.g.{' '}
              <code>acme.goskope.com</code>).
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connect',
      label: '3. Connect',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On the <strong>Connections</strong> page create a <strong>netskope</strong> connection
              and attach the credential. Use <strong>Test</strong> to verify the token and endpoint
              privilege.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. URL-list changes are <strong>staged</strong>, then the app issues a single
              <strong> deploy</strong> to apply all pending changes — note that deploy applies every
              pending url-list change on the tenant, so avoid editing url lists elsewhere at the same
              time.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
