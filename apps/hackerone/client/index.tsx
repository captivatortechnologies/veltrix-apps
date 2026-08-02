import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'hackerone',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/hackerone/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/hackerone/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/hackerone/connections', label: 'Connections', icon: 'link' },
  ],
}
