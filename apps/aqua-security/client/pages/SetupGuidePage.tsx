import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Image assurance policies',
  'Host assurance policies',
  'Function assurance policies',
  'Kubernetes assurance policies',
  'Container runtime policies',
  'Host runtime policies',
  'Firewall policies',
  'Application scopes',
  'Enforcer groups',
]

/**
 * Step-by-step connection guide for Aqua Security, rendered with the
 * platform design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Aqua user',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Aqua Console, create a dedicated user with a Role + Permission Set granting API
              access to the resources below (Aqua's own guidance: use a dedicated "API Only" user for
              automation rather than a personal admin account). This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the user's id/email as the credential <strong>username</strong> and their password as the
              credential <strong>password</strong> on the <strong>Connections</strong> page.
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
              On <strong>Connections</strong>, add a connection whose endpoint is your Aqua{' '}
              <strong>Console base URL</strong> (self-hosted or single-tenant Aqua-hosted Console), e.g.{' '}
              <code>https://aqua.example.com</code> — and attach the Aqua user credential. Use{' '}
              <strong>Test</strong> to verify the Console is reachable and the credential authenticates
              (session login via <code>POST /api/v1/login</code>, then{' '}
              <code>GET /api/v2/access_management/scopes/&lt;probe&gt;</code>). Saving the connection also
              registers an Aqua Security deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick an Aqua Security configuration type, author
              your policies, and deploy through the pipeline. Application Scopes are referenced by name from
              assurance and runtime policies — create the scopes a policy needs before (or in the same
              deploy as) the policy that references them. Drift detection and rollback are handled per type;
              turning a policy <em>off</em> (where the type has an Enabled toggle) removes it from Aqua rather
              than leaving a disabled object behind.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
