/**
 * Phase 10 — Early Exit Monitoring.
 *
 * Shows confirmed early_exit_events (real rows, produced by
 * cims.evaluate_student_presence's state machine — see
 * supabase/migrations/20260101001700_early_exit_monitoring.sql) within the
 * caller's authorised scope, and lets exit_events.authorize holders (HOD/
 * ADMIN) record and decide authorized-exit requests.
 *
 * No live location feed exists in this environment to demonstrate the
 * engine running unattended (docs/22 ADR-014's same limitation extends
 * here) — but the engine itself is real and fully exercised by pgTAP
 * (supabase/tests/database/008_phase10_early_exit.test.sql, 15 assertions).
 * This page reads whatever the engine has actually produced; it does not
 * simulate or fabricate exit activity.
 */
import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Plus } from 'lucide-react';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type ExitEvent = Database['public']['Tables']['early_exit_events']['Row'] & {
  students: { register_number: string; users: { full_name: string } | null } | null;
};

type AuthorizedExit = Database['public']['Tables']['authorized_exits']['Row'] & {
  students: { register_number: string; users: { full_name: string } | null } | null;
};

const EVENT_SELECT = '*, students(register_number, users(full_name))';

const VERIFICATION_TONE: Record<string, string> = {
  EXIT_CONFIRMED: 'bg-status-error/10 text-status-error',
  AUTHORIZED_EARLY_EXIT: 'bg-status-info/10 text-status-info',
  RE_ENTERED: 'bg-status-success/10 text-status-success',
};

const EarlyExitPage: React.FC = () => {
  const { profile } = useAuth();
  const canAuthorize = hasPermission(profile, 'exit_events.authorize');

  const [tab, setTab] = useState<'events' | 'authorized'> ('events');

  const eventsTable = useSupabaseTable<'early_exit_events', ExitEvent>('early_exit_events', {
    select: EVENT_SELECT,
    orderBy: { column: 'exit_confirmed_at', ascending: false },
    pageSize: 100,
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex bg-panel border border-border-default rounded-lg p-1 w-fit">
        {(['events', 'authorized'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${tab === t ? 'bg-accent-primary text-white shadow-md' : 'text-text-muted hover:text-text-primary'}`}
          >
            {t === 'events' ? 'Exit Events' : 'Authorized Exits'}
          </button>
        ))}
      </div>

      {tab === 'events' ? (
        <div className="space-y-3">
          {eventsTable.isLoading ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : eventsTable.rows.length === 0 ? (
            <div className="p-12 bg-panel border border-border-default rounded-xl text-center text-text-muted text-sm">
              No early-exit events recorded in your scope.
            </div>
          ) : (
            eventsTable.rows.map((e) => (
              <div key={e.id} className="p-4 bg-panel border border-border-default rounded-xl flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-full ${e.verification_state === 'RE_ENTERED' ? 'bg-status-success/10 text-status-success' : e.verification_state === 'AUTHORIZED_EARLY_EXIT' ? 'bg-status-info/10 text-status-info' : 'bg-status-error/10 text-status-error'}`}>
                    {e.verification_state === 'RE_ENTERED' ? <CheckCircle2 size={16} /> : e.verification_state === 'AUTHORIZED_EARLY_EXIT' ? <Clock size={16} /> : <AlertTriangle size={16} />}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-text-primary">{e.students?.users?.full_name ?? e.students?.register_number}</div>
                    <div className="text-xs text-text-muted mt-0.5">
                      Exited {new Date(e.exit_confirmed_at).toLocaleString()}
                      {e.re_entered_at && ` · Re-entered ${new Date(e.re_entered_at).toLocaleString()}`}
                    </div>
                  </div>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${VERIFICATION_TONE[e.verification_state] ?? 'bg-main text-text-muted'}`}>
                  {e.verification_state.replace(/_/g, ' ')}
                </span>
              </div>
            ))
          )}
        </div>
      ) : (
        <AuthorizedExitsTab canAuthorize={canAuthorize} />
      )}
    </div>
  );
};

const AuthorizedExitsTab: React.FC<{ canAuthorize: boolean }> = ({ canAuthorize }) => {
  const { showToast } = useToast();
  const table = useSupabaseTable<'authorized_exits', AuthorizedExit>('authorized_exits', {
    select: '*, students(register_number, users(full_name))',
    orderBy: { column: 'exit_date', ascending: false },
    pageSize: 100,
  });
  const { options: students } = useLookupOptions('students', 'id, register_number, users(full_name)');

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ student_id: '', exit_date: new Date().toISOString().split('T')[0]!, permitted_exit_time: '12:00', reason: '' });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await table.insert({ ...form, status: 'APPROVED' } as never);
    setSubmitting(false);
    if (result.error) return showToast(result.error, 'error');
    showToast('Authorized exit recorded.', 'success');
    setShowModal(false);
    setForm({ student_id: '', exit_date: new Date().toISOString().split('T')[0]!, permitted_exit_time: '12:00', reason: '' });
  };

  const handleDecide = async (id: string, approve: boolean) => {
    const { error } = await supabase.rpc('decide_authorized_exit', { p_id: id, p_approve: approve });
    if (error) showToast(error.message, 'error');
    else {
      showToast(approve ? 'Approved.' : 'Rejected.', 'success');
      table.refetch();
    }
  };

  const columns: EntityColumn<AuthorizedExit>[] = [
    { key: 'student', header: 'Student', render: (a) => a.students?.users?.full_name ?? a.students?.register_number ?? '—' },
    { key: 'date', header: 'Date', render: (a) => a.exit_date },
    { key: 'time', header: 'Permitted Time', render: (a) => a.permitted_exit_time.slice(0, 5) },
    { key: 'reason', header: 'Reason', render: (a) => <span className="text-xs">{a.reason}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (a) => (
        <span className={`text-xs px-2 py-1 rounded-full font-medium ${a.status === 'APPROVED' ? 'bg-status-success/10 text-status-success' : a.status === 'REJECTED' ? 'bg-status-error/10 text-status-error' : 'bg-status-warning/10 text-status-warning'}`}>
          {a.status}
        </span>
      ),
    },
  ];

  return (
    <>
      <EntityListPage
        title="Authorized Exits"
        columns={columns}
        rows={table.rows}
        rowKey={(a) => a.id}
        searchQuery={table.searchQuery}
        onSearchChange={table.setSearchQuery}
        isSearching={table.isSearching}
        emptyMessage={table.error ?? 'No authorized exit requests.'}
        headerActions={
          canAuthorize && (
            <button onClick={() => setShowModal(true)} className="px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg flex items-center gap-2">
              <Plus size={16} /> Record Authorized Exit
            </button>
          )
        }
        rowActions={
          canAuthorize
            ? [
                { label: 'Approve', icon: CheckCircle2, onClick: (a) => handleDecide(a.id, true), hidden: (a) => a.status !== 'PENDING' },
              ]
            : []
        }
      />

      {showModal && (
        <Modal title="Record Authorized Exit" onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Student</label>
              <select required className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary" value={form.student_id} onChange={(e) => setForm({ ...form, student_id: e.target.value })}>
                <option value="">Select...</option>
                {students.map((s) => (
                  <option key={String(s.id)} value={String(s.id)}>
                    {(s.users as { full_name: string } | null)?.full_name ?? String(s.register_number)}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Date</label>
                <input type="date" required className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary" value={form.exit_date} onChange={(e) => setForm({ ...form, exit_date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Permitted Exit Time</label>
                <input type="time" required className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary" value={form.permitted_exit_time} onChange={(e) => setForm({ ...form, permitted_exit_time: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Reason</label>
              <textarea required rows={3} className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary resize-none" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
              <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
                {submitting ? 'Saving...' : 'Record & Approve'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
};

export default EarlyExitPage;
