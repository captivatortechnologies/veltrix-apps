import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'GitHub Advanced Security',
  'Secret scanning',
  'Push protection',
  'Dependabot security updates',
  'CodeQL default setup',
]

/**
 * Step-by-step connection guide for GitHub Advanced Security, rendered with the
 * platform design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In GitHub, create a token for a user (or GitHub App) with permission to administer the target
              repositories. A fine-grained personal access token needs the repository{' '}
              <strong>Administration</strong> and <strong>Code security</strong> (read &amp; write) permissions;
              a classic token needs the <strong>repo</strong> and <strong>security_events</strong> scopes. This
              app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the token as a Veltrix credential on the <strong>Connections</strong> page. GitHub
              authenticates with the token alone (sent as a Bearer token); no username is required.
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
              On <strong>Connections</strong>, add a connection whose endpoint is <code>api.github.com</code>{' '}
              (GitHub.com) or your GitHub Enterprise Server host, and attach the token. Use <strong>Test</strong>{' '}
              to verify GitHub is reachable and the token authenticates (GET <code>/user</code>). Saving the
              connection also registers a GitHub deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the{' '}
              <strong>Repository Security</strong> configuration type, add repositories by{' '}
              <code>owner/repo</code>, toggle the security features you want enabled, and deploy through the
              pipeline. Drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
