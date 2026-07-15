import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'okta-identity',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/okta-identity/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/okta-identity/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/okta-identity/connections', label: 'Connections', icon: 'link' },
  ],
}
