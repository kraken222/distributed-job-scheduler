import type { ReactNode } from 'react';
import { fmtDuration } from './api';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`stat-card ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-banner">{message}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export interface Bucket {
  bucketStart: number;
  completed: number;
  failed: number;
}

/** Dependency-free stacked bar chart for executions/minute. */
export function ThroughputChart({ buckets }: { buckets: Bucket[] }) {
  const W = 720;
  const H = 160;
  const pad = 24;
  const max = Math.max(1, ...buckets.map((b) => b.completed + b.failed));
  const bw = (W - pad * 2) / Math.max(1, buckets.length);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" preserveAspectRatio="none" role="img" aria-label="Throughput chart">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={pad} x2={W - pad} y1={H - pad - f * (H - pad * 2)} y2={H - pad - f * (H - pad * 2)} className="chart-grid" />
          <text x={4} y={H - pad - f * (H - pad * 2) + 4} className="chart-tick">
            {Math.round(max * f)}
          </text>
        </g>
      ))}
      {buckets.map((b, i) => {
        const total = b.completed + b.failed;
        const hOk = ((H - pad * 2) * b.completed) / max;
        const hBad = ((H - pad * 2) * b.failed) / max;
        const x = pad + i * bw;
        return (
          <g key={b.bucketStart}>
            <title>
              {new Date(b.bucketStart).toLocaleTimeString()}: {b.completed} ok, {b.failed} failed
            </title>
            {total === 0 ? (
              <rect x={x + 1} y={H - pad - 1} width={Math.max(1, bw - 2)} height={1} className="bar-empty" />
            ) : (
              <>
                <rect x={x + 1} y={H - pad - hOk} width={Math.max(1, bw - 2)} height={hOk} className="bar-ok" />
                <rect x={x + 1} y={H - pad - hOk - hBad} width={Math.max(1, bw - 2)} height={hBad} className="bar-bad" />
              </>
            )}
          </g>
        );
      })}
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} className="chart-axis" />
    </svg>
  );
}

export function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Prev
      </button>
      <span>
        Page {page} / {totalPages}
      </span>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
    </div>
  );
}

export function DurationCell({ ms }: { ms: number | null }) {
  return <span className="mono">{fmtDuration(ms)}</span>;
}

export function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}
