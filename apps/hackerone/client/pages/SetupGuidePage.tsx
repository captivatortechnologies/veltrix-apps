import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Structured Scopes']

/**
 * Step-by-step connection guide for HackerOne, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API Token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In HackerOne, create an <strong>API token</strong> under{' '}
              <strong>Organization Settings → API Tokens</strong>. HackerOne shows the token as a pair: an{' '}
              <strong>identifier</strong> (the token name) and a <strong>token value</strong>. The token needs
              permission to read your programs and manage program scope so it can author:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              HackerOne authenticates with <strong>HTTP Basic</strong> — the identifier is the username and the
              token value is the password (<code>Authorization: Basic base64(identifier:token)</code>).
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
              On <strong>Connections</strong>, add a connection and store the token: put the{' '}
              <strong>identifier</strong> in the <strong>API username</strong> field and the{' '}
              <strong>token value</strong> in the <strong>API token</strong> field. The API host is fixed at{' '}
              <code>api.hackerone.com</code>. Use <strong>Test</strong> to verify the credential authenticates
              (<code>GET /me/programs</code>). Saving the connection also registers the HackerOne API as a
              deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the HackerOne{' '}
              <strong>Structured Scopes</strong> configuration type, and add a scope per asset: its{' '}
              <strong>program handle</strong>, the <strong>asset identifier</strong> and type, whether it is
              eligible for submission / bounty, its max severity and any tester instruction. Deploy through the
              pipeline — each asset is created or updated within its program (upsert by identifier), and drift
              detection and rollback are handled per scope.
            </p>
            <p>
              Note: HackerOne removed the program-level scope write endpoints from its public docs on
              2026-04-07 (assets are now managed via organization asset-management endpoints). Verify the write
              path against your live HackerOne API before relying on deploy in production.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
