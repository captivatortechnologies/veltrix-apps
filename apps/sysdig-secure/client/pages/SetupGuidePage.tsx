import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Custom Falco rules']

/**
 * Step-by-step connection guide for Sysdig Secure, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Sysdig Secure, open the user menu → <strong>Settings → Sysdig Secure API</strong> (or use a
              team-based / global service account) and copy the <strong>API token</strong>. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API token as a Veltrix credential on the <strong>Connections</strong> page. Sysdig
              authenticates with the token alone (sent as <code>Authorization: Bearer &lt;token&gt;</code>) — no
              username is required.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection whose endpoint is your Sysdig{' '}
              <strong>region base URL</strong> — the address of your Sysdig console, e.g.{' '}
              <code>https://us2.app.sysdig.com</code> (US-East default is <code>https://secure.sysdig.com</code>)
              — and attach the API token. Use <strong>Test</strong> to verify Sysdig is reachable and the token
              authenticates (GET <code>/api/secure/rules/groups</code>). Saving the connection also registers a
              Sysdig Secure deploy target.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '3. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong>, pick the Sysdig{' '}
              <strong>Falco Rules</strong> configuration type, author your rules (name, condition, output,
              priority, source), and deploy through the pipeline. Drift detection and rollback are handled per
              type. Turning a rule <em>off</em> removes it from the custom rule library (Sysdig has no per-rule
              disable).
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
