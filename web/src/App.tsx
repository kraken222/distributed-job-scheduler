import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  LayoutDashboard,
  Layers,
  LogOut,
  ServerCog,
  ShieldCheck,
  Timer,
  Zap,
} from 'lucide-react';
import { api, getToken, setToken } from './api';
import { useLiveStatus } from './hooks';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Queues } from './pages/Queues';
import { QueueDetail } from './pages/QueueDetail';
import { JobDetail } from './pages/JobDetail';
import { Workers } from './pages/Workers';
import { Dlq } from './pages/Dlq';
import { Schedules } from './pages/Schedules';
import { Policies } from './pages/Policies';
import { Events } from './pages/Events';

export interface Project {
  id: string;
  name: string;
  queue_count?: number;
}

interface ProjectCtx {
  projects: Project[];
  project: Project | null;
  setProjectId: (id: string) => void;
  reloadProjects: () => Promise<void>;
}

const Ctx = createContext<ProjectCtx>(null!);
export const useProject = () => useContext(Ctx);

function Shell() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(localStorage.getItem('jobscheduler.project'));
  const location = useLocation();
  const live = useLiveStatus();

  async function reloadProjects() {
    const res = await api<{ data: Project[] }>('/api/projects');
    setProjects(res.data);
    if (res.data.length > 0 && !res.data.some((p) => p.id === projectId)) {
      selectProject(res.data[0].id);
    }
  }

  function selectProject(id: string) {
    localStorage.setItem('jobscheduler.project', id);
    setProjectId(id);
  }

  useEffect(() => {
    void reloadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const project = projects.find((p) => p.id === projectId) ?? null;

  return (
    <Ctx.Provider value={{ projects, project, setProjectId: selectProject, reloadProjects }}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <Timer size={28} />
            <div>
              <strong>JobScheduler</strong>
              <span>distributed job platform</span>
            </div>
          </div>
          <select
            className="project-select"
            value={projectId ?? ''}
            onChange={(e) => selectProject(e.target.value)}
            aria-label="Project"
          >
            {projects.length === 0 && <option value="">no projects yet</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <nav>
            <NavLink to="/" end><LayoutDashboard size={16} /> Dashboard</NavLink>
            <NavLink to="/queues"><Layers size={16} /> Queues</NavLink>
            <NavLink to="/schedules"><CalendarClock size={16} /> Schedules</NavLink>
            <NavLink to="/events"><Zap size={16} /> Events</NavLink>
            <NavLink to="/policies"><ShieldCheck size={16} /> Retry Policies</NavLink>
            <NavLink to="/workers"><ServerCog size={16} /> Workers</NavLink>
            <NavLink to="/dlq"><AlertTriangle size={16} /> Dead Letters</NavLink>
          </nav>
          <div className="live-indicator" title={live ? 'Live updates over WebSocket' : 'WebSocket down — falling back to polling'}>
            <span className={`live-dot ${live ? 'live-on' : 'live-off'}`} />
            {live ? 'Live' : 'Polling'}
          </div>
          <div className="sidebar-footer">
            <button
              onClick={() => {
                setToken(null);
                window.location.href = '/login';
              }}
              title="Sign out"
            >
              <LogOut size={16} /> Sign out
            </button>
          </div>
        </aside>
        <main className="content" key={location.pathname}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/queues" element={<Queues />} />
            <Route path="/queues/:queueId" element={<QueueDetail />} />
            <Route path="/jobs/:jobId" element={<JobDetail />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/events" element={<Events />} />
            <Route path="/policies" element={<Policies />} />
            <Route path="/workers" element={<Workers />} />
            <Route path="/dlq" element={<Dlq />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </Ctx.Provider>
  );
}

/** Re-evaluates the token on every navigation (a static element would go stale after login). */
function RequireAuth() {
  return getToken() ? <Shell /> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<RequireAuth />} />
      </Routes>
    </BrowserRouter>
  );
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link className="back-link" to={to}>
      <ArrowLeft size={14} /> {label}
    </Link>
  );
}

export function PageHead({
  title,
  subtitle,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </header>
  );
}
