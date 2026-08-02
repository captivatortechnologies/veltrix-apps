import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'auth0',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/auth0/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/auth0/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/auth0/connections', label: 'Connections', icon: 'link' },
  ],
}
