/**
 * Phase 19 (Security Hardening) — Audit Center.
 *
 * Deeper than the "Audit" tab already on ReportsPage.tsx (docs/10's report
 * category, date range + CSV export): this is the drill-down tool a
 * security review actually needs — actor identified by name (not just
 * role), filterable by action type and entity type, and a per-row diff
 * view of exactly what changed (old_values/new_values), which the report
 * export deliberately omits to keep CSVs flat. Both read the same
 * `report_audit_log` RPC (supabase/migrations/20260101002100_reports_views.sql),
 * itself SECURITY INVOKER over `audit_logs_select` RLS (docs/13: no report
 * or admin screen ever widens what its caller could already see) — this
 * page adds no new backend surface, only a richer read of the existing one.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ShieldAlert, Eye, X } from 'lucide-react';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import FilterSelect from '@/components/ui/FilterSelect';
import Modal from '@/components/ui/Modal';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type AuditRow = Database['public']['Tables']['audit_logs']['Row'];

const ACTIONS: Database['public']['Enums']['audit_action'][] = [
  'INSERT', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'PERMISSION_DENIED',
  'EXPORT', 'GENERATE', 'AI_TOOL_CALL', 'AI_WRITE_ACTION', 'PRIVILEGED_READ',
];

const ACTION_TONE: Record<string, string> = {
  DELETE: 'bg-status-error/10 text-status-error',
  PERMISSION_DENIED: 'bg-status-error/10 text-status-error',
  UPDATE: 'bg-status-warning/10 text-status-warning',
  AI_WRITE_ACTION: 'bg-status-warning/10 text-status-warning',
  INSERT: 'bg-status-success/10 text-status-success',
  AI_TOOL_CALL: 'bg-accent-primary/10 text-accent-primary',
};

const AuditPage: React.FC = () => {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditRow | null>(null);

  const { options: userOptions } = useLookupOptions('users', 'id, full_name');
  const userNameById = useMemo(() => new Map(userOptions.map((u) => [String(u.id), String(u.full_name)])), [userOptions]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const { data, error: rpcError } = await supabase.rpc('report_audit_log', {
          p_from: fromDate ? new Date(fromDate).toISOString() : undefined,
          p_to: toDate ? new Date(toDate + 'T23:59:59').toISOString() : undefined,
          p_entity_type: entityType || undefined,
          p_action: (action || undefined) as Database['public']['Enums']['audit_action'] | undefined,
        });
        if (cancelled) return;
        if (rpcError) {
          setError(rpcError.message);
          setRows([]);
        } else {
          setRows((data ?? []) as AuditRow[]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromDate, toDate, action, entityType]);

  const entityTypes = useMemo(() => Array.from(new Set(rows.map((r) => r.entity_type))).sort(), [rows]);

  const columns: EntityColumn<AuditRow>[] = [
    { key: 'occurred', header: 'When', render: (r) => new Date(r.occurred_at).toLocaleString() },
    {
      key: 'action',
      header: 'Action',
      render: (r) => (
        <span className={`text-xs px-2 py-1 rounded-full font-medium ${ACTION_TONE[r.action] ?? 'bg-panel text-text-secondary'}`}>{r.action}</span>
      ),
    },
    { key: 'entity', header: 'Entity', render: (r) => `${r.entity_type}${r.entity_id ? ` #${r.entity_id.slice(0, 8)}` : ''}` },
    { key: 'actor', header: 'Actor', render: (r) => (r.actor_id ? userNameById.get(r.actor_id) ?? r.actor_role ?? '—' : 'system') },
    { key: 'reason', header: 'Reason', render: (r) => r.reason ?? '—' },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-6 h-6 text-accent-primary" />
        <div>
          <h2 className="text-2xl font-bold text-text-primary">Audit Center</h2>
          <p className="text-text-secondary mt-1">Immutable, hash-chained history of every regulated action — filter, then open a row for the full before/after diff.</p>
        </div>
      </div>

      <EntityListPage
        title="Audit Trail"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.id)}
        searchQuery=""
        onSearchChange={() => {}}
        isSearching={isLoading}
        emptyMessage={error ?? 'No audit entries in scope for this filter.'}
        filters={
          <>
            <div className="min-w-[140px]">
              <label className="text-[10px] text-text-muted uppercase font-bold tracking-wider block mb-1">From</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary" />
            </div>
            <div className="min-w-[140px]">
              <label className="text-[10px] text-text-muted uppercase font-bold tracking-wider block mb-1">To</label>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-full bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary" />
            </div>
            <FilterSelect label="Action" value={action} onChange={setAction} options={ACTIONS.map((a) => ({ value: a, label: a }))} />
            <FilterSelect label="Entity" value={entityType} onChange={setEntityType} options={entityTypes.map((e) => ({ value: e, label: e }))} />
          </>
        }
        rowActions={[{ label: 'View diff', icon: Eye, onClick: setDetail }]}
      />

      {detail && (
        <Modal title={`${detail.action} — ${detail.entity_type}${detail.entity_id ? ` #${detail.entity_id.slice(0, 8)}` : ''}`} onClose={() => setDetail(null)} maxWidth="max-w-2xl">
          <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto text-sm">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-text-muted uppercase font-bold">When</div>
                <div className="text-text-primary mt-0.5">{new Date(detail.occurred_at).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-text-muted uppercase font-bold">Actor</div>
                <div className="text-text-primary mt-0.5">{detail.actor_id ? userNameById.get(detail.actor_id) ?? detail.actor_role ?? '—' : 'system'}</div>
              </div>
              {detail.reason && (
                <div className="col-span-2">
                  <div className="text-text-muted uppercase font-bold">Reason</div>
                  <div className="text-text-primary mt-0.5">{detail.reason}</div>
                </div>
              )}
            </div>
            <div>
              <div className="text-text-muted uppercase font-bold text-xs mb-1">Before</div>
              <pre className="bg-main border border-border-default rounded-lg p-3 text-[11px] overflow-x-auto text-text-secondary">
                {detail.old_values ? JSON.stringify(detail.old_values, null, 2) : '—'}
              </pre>
            </div>
            <div>
              <div className="text-text-muted uppercase font-bold text-xs mb-1">After</div>
              <pre className="bg-main border border-border-default rounded-lg p-3 text-[11px] overflow-x-auto text-text-secondary">
                {detail.new_values ? JSON.stringify(detail.new_values, null, 2) : '—'}
              </pre>
            </div>
            {/* Phase 18 — KAREN tool calls carry a duration_ms here (see
                karen_log_tool_call); everything else keeps metadata empty,
                so this only ever renders for AI_TOOL_CALL/AI_WRITE_ACTION rows. */}
            {detail.metadata && typeof detail.metadata === 'object' && 'duration_ms' in (detail.metadata as object) && (
              <div>
                <div className="text-text-muted uppercase font-bold text-xs mb-1">Latency</div>
                <div className="text-text-primary">{String((detail.metadata as Record<string, unknown>).duration_ms)} ms</div>
              </div>
            )}
            <button
              onClick={() => setDetail(null)}
              className="w-full py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center gap-2"
            >
              <X size={16} /> Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default AuditPage;
