import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useApp } from './store.jsx';
import Shell from './Shell.jsx';
// LoginPage stays eager: it is the auth gate and must render instantly.
import LoginPage from './pages/LoginPage.jsx';

// Every other page is lazy-loaded so its code is fetched only when the route
// is opened — the initial FleetView bundle stays small. Same pattern as the
// admin SPA (admin/src/App.jsx).
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const TasksPage = lazy(() => import('./pages/TasksPage.jsx'));
const LoadsPage = lazy(() => import('./pages/LoadsPage.jsx'));
const UpdateBoard = lazy(() => import('./pages/UpdateBoard.jsx'));
const DispatchBoard = lazy(() => import('./pages/DispatchBoard.jsx'));
const DispatchMap = lazy(() => import('./pages/DispatchMap.jsx'));
const EmailsPage = lazy(() => import('./pages/EmailsPage.jsx'));
const RateSavings = lazy(() => import('./pages/RateSavings.jsx'));
const Statistics = lazy(() => import('./pages/Statistics.jsx'));
const UsersPage = lazy(() => import('./pages/UsersPage.jsx'));
const BrokersPage = lazy(() => import('./pages/BrokersPage.jsx'));
const DriversPage = lazy(() => import('./pages/DriversPage.jsx'));
const EquipmentPage = lazy(() => import('./pages/EquipmentPage.jsx'));
const TrailerTrackingPage = lazy(() => import('./pages/TrailerTrackingPage.jsx'));
const FuelTolls = lazy(() => import('./pages/FuelTolls.jsx'));
const CompaniesPage = lazy(() => import('./pages/CompaniesPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const SupportPage = lazy(() => import('./pages/SupportPage.jsx'));
const HelpPage = lazy(() => import('./pages/HelpPage.jsx'));

/**
 * A failed lazy chunk (deploy replaced the hashed file, network hiccup) must
 * never leave a blank screen — offer a reload instead.
 */
class ChunkErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div style={{ padding: 40 }}>
          <p>Could not load this page (a new version may have been deployed).</p>
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>{t.type === 'error' ? '⚠' : '✓'} {t.message}</div>
      ))}
    </div>
  );
}

function Protected({ children }) {
  const { me, loadingMe } = useApp();
  const loc = useLocation();
  if (loadingMe) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <>
      <ChunkErrorBoundary>
      <Suspense fallback={<div style={{ padding: 40 }}>Loading…</div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
        <Route path="/dashboard/tasks" element={<Protected><TasksPage /></Protected>} />
        <Route path="/dashboard/loads" element={<Protected><LoadsPage /></Protected>} />
        <Route path="/dashboard/update-board" element={<Protected><UpdateBoard /></Protected>} />
        <Route path="/dashboard/dispatch-board" element={<Protected><DispatchBoard /></Protected>} />
        <Route path="/dashboard/dispatch-map" element={<Protected><DispatchMap /></Protected>} />
        <Route path="/dashboard/emails" element={<Protected><EmailsPage /></Protected>} />
        <Route path="/dashboard/rate-savings" element={<Protected><RateSavings /></Protected>} />
        <Route path="/dashboard/statistics" element={<Protected><Statistics /></Protected>} />
        <Route path="/dashboard/users" element={<Protected><UsersPage /></Protected>} />
        <Route path="/dashboard/brokers" element={<Protected><BrokersPage /></Protected>} />
        <Route path="/dashboard/drivers" element={<Protected><DriversPage /></Protected>} />
        <Route path="/dashboard/equipments" element={<Protected><EquipmentPage /></Protected>} />
        <Route path="/dashboard/trailers" element={<Protected><TrailerTrackingPage /></Protected>} />
        <Route path="/dashboard/fuel-tolls" element={<Protected><FuelTolls /></Protected>} />
        <Route path="/dashboard/companies" element={<Protected><CompaniesPage /></Protected>} />
        <Route path="/dashboard/settings" element={<Protected><SettingsPage /></Protected>} />
        <Route path="/support" element={<Protected><SupportPage /></Protected>} />
        <Route path="/help" element={<Protected><HelpPage /></Protected>} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      </Suspense>
      </ChunkErrorBoundary>
      <Toasts />
    </>
  );
}
