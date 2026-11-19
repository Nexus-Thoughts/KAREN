/**
 * Phase 9 — live attendance dashboard.
 *
 * Faculty/HOD/admin see today's class sessions within their scope
 * (class_sessions_select — reuses cims.my_section_ids(), same as Timetable),
 * open one, and see the real per-student engine state: Expected / Detected /
 * Verified (Present+Late) / Pending / Absent, sourced entirely from
 * attendance_records — never fabricated counts.
 *
 * No live scheduler runs in this environment (docs/22 ADR-014) — the
 * "Refresh" button IS the evaluation trigger a real deployment's Edge
 * Function/cron would call automatically. This page makes that real,
 * callable engine visible and usable today, not a placeholder for it.
 *
 * A student sees their own attendance through Student Calendar
 * (StudentCalendarPage), not this dashboard — this screen's roster view
 * would otherwise let a student read classmates' individual statuses, which
 * attendance_records_select's RLS (docs/22 ADR-015) specifically prevents;
 * this page simply never renders for a bare STUDENT (see router.tsx).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, CheckCircle2, Lock } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type ClassSession = Database['public']['Tables']['class_sessions']['Row'] & {
  sections: { name: string; year: number } | null;
  subjects: { code: string; name: string } | null;
  classrooms: { name: string } | null;
};

type AttendanceRecord = Database['public']['Tables']['attendance_records']['Row'] & {
  students: { register_number: string; users: { full_name: string } | null } | null;
};

const SESSION_SELECT = '*, sections(name, year), subjects(code, name), classrooms(name)';
const RECORD_SELECT = '*, students(register_number, users(full_name))';

const VERIFIED = new Set(['PRESENT', 'LATE', 'MANUAL_PRESENT']);
const ABSENTISH = new Set(['ABSENT', 'MANUAL_ABSENT', 'OUTSIDE_CLASSROOM', 'OUTSIDE_CAMPUS']);
const PENDINGISH = new Set(['PENDING', 'DETECTED', 'VERIFYING', 'LOW_GPS_ACCURACY']);

const STATUS_TONE: Record<string, string> = {
  PRESENT: 'bg-status-success/10 text-status-success',
  MANUAL_PRESENT: 'bg-status-success/10 text-status-success',
  LATE: 'bg-status-warning/10 text-status-warning',
  ABSENT: 'bg-status-error/10 text-status-error',
  MANUAL_ABSENT: 'bg-status-error/10 text-status-error',
  OUTSIDE_CLASSROOM: 'bg-status-error/10 text-status-error',
  OUTSIDE_CAMPUS: 'bg-status-error/10 text-status-error',
  LOW_GPS_ACCURACY: 'bg-purple-500/10 text-purple-400',
  PENDING: 'bg-main text-text-muted',
  DETECTED: 'bg-status-info/10 text-status-info',
  VERIFYING: 'bg-status-info/10 text-status-info',
};

const AttendancePage: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canOverride = hasPermission(profile, 'attendance.override');
  const canFinalize = hasPermission(profile, 'attendance.finalize');

  const today = new Date().toISOString().split('T')[0];

  const sessionsTable = useSupabaseTable<'class_sessions', ClassSession>('class_sessions', {
    select: SESSION_SELECT,
    orderBy: { column: 'scheduled_start' },
    filters: { session_date: today! },
    pageSize: 100,
  });

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [records, setRecords] = useState<AttendanceRecord[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [overriding, setOverriding] = useState<AttendanceRecord | null>(null);

  const selectedSession = useMemo(
    () => sessionsTable.rows.find((s) => s.id === selectedSessionId) ?? null,
    [sessionsTable.rows, selectedSessionId]
  );

  const loadRecords = async (sessionId: string) => {
    const { data } = await supabase
      .from('attendance_records')
      .select(RECORD_SELECT)
      .eq('class_session_id', sessionId);
    setRecords((data ?? []) as unknown as AttendanceRecord[]);
  };

  useEffect(() => {
    if (selectedSessionId) loadRecords(selectedSessionId);
    else setRecords(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

  const handleRefresh = async () => {
    if (!selectedSessionId) return;
    setRefreshing(true);
    const { error } = await supabase.rpc('evaluate_class_session', { p_class_session_id: selectedSessionId });
    setRefreshing(false);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadRecords(selectedSessionId);
  };

  const handleFinalize = async () => {
    if (!selectedSessionId) return;
    if (!window.confirm('Finalize attendance for this session? Remaining pending students will be marked Absent or Outside Classroom.')) return;
    setFinalizing(true);
    const { error } = await supabase.rpc('finalize_class_session', { p_class_session_id: selectedSessionId });
    setFinalizing(false);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast('Session finalized.', 'success');
    await loadRecords(selectedSessionId);
    sessionsTable.refetch();
  };

  const counts = useMemo(() => {
    if (!records) return null;
    return {
      expected: records.length,
      verified: records.filter((r) => VERIFIED.has(r.status)).length,
      pending: records.filter((r) => PENDINGISH.has(r.status)).length,
      absent: records.filter((r) => ABSENTISH.has(r.status)).length,
    };
  }, [records]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">Live Attendance</h2>
        <p className="text-text-secondary mt-1">Today's class sessions within your authorised scope.</p>
      </div>

      {sessionsTable.isLoading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : sessionsTable.rows.length === 0 ? (
        <div className="p-12 bg-panel border border-border-default rounded-xl text-center text-text-muted text-sm">
          No class sessions today. Sessions are created from the timetable via{' '}
          <code className="text-xs bg-main px-1 py-0.5 rounded">get_or_create_class_session</code> — a real
          deployment triggers this from a scheduler at each timetable slot.
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {sessionsTable.rows.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedSessionId(s.id)}
              className={`px-4 py-3 rounded-xl border text-left transition-colors ${
                selectedSessionId === s.id ? 'bg-accent-primary/10 border-accent-primary' : 'bg-panel border-border-default hover:border-accent-primary/50'
              }`}
            >
              <div className="text-sm font-medium text-text-primary">{s.subjects?.code} — {s.sections ? `Year ${s.sections.year}-${s.sections.name}` : '—'}</div>
              <div className="text-xs text-text-muted mt-0.5">
                {s.classrooms?.name} · {s.scheduled_start.slice(11, 16)}–{s.scheduled_end.slice(11, 16)} · {s.status}
              </div>
            </button>
          ))}
        </div>
      )}

      {selectedSession && (
        <div className="bg-panel border border-border-default rounded-xl overflow-hidden">
          <div className="p-4 border-b border-border-default bg-main/30 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h3 className="font-semibold text-text-primary">
                {selectedSession.subjects?.code} — {selectedSession.subjects?.name}
              </h3>
              <p className="text-xs text-text-muted mt-0.5">
                {selectedSession.sections ? `Year ${selectedSession.sections.year}-${selectedSession.sections.name}` : '—'} · {selectedSession.classrooms?.name}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleRefresh}
                disabled={refreshing || selectedSession.status === 'CLOSED'}
                className="px-3 py-2 bg-panel border border-border-default rounded-lg text-sm text-text-secondary hover:text-text-primary disabled:opacity-50 flex items-center gap-2"
              >
                <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
              </button>
              {canFinalize && selectedSession.status !== 'CLOSED' && (
                <button
                  onClick={handleFinalize}
                  disabled={finalizing}
                  className="px-3 py-2 bg-accent-primary text-white rounded-lg text-sm hover:bg-accent-secondary disabled:opacity-50 flex items-center gap-2"
                >
                  <Lock size={14} /> Finalize
                </button>
              )}
              {selectedSession.status === 'CLOSED' && (
                <span className="px-3 py-2 text-xs text-text-muted flex items-center gap-1"><CheckCircle2 size={14} /> Closed</span>
              )}
            </div>
          </div>

          {counts && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b border-border-default">
              <StatTile label="Expected" value={counts.expected} />
              <StatTile label="Verified Present" value={counts.verified} tone="text-status-success" />
              <StatTile label="Pending" value={counts.pending} tone="text-status-info" />
              <StatTile label="Absent" value={counts.absent} tone="text-status-error" />
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[600px]">
              <thead>
                <tr className="bg-main/50 text-text-muted text-xs uppercase tracking-wider">
                  <th className="p-4 font-medium">Student</th>
                  <th className="p-4 font-medium">Status</th>
                  <th className="p-4 font-medium">Distance</th>
                  <th className="p-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {(records ?? []).map((r) => (
                  <tr key={r.id} className="hover:bg-main/50 transition-colors">
                    <td className="p-4">
                      <div className="text-sm font-medium text-text-primary">{r.students?.users?.full_name ?? '—'}</div>
                      <div className="text-xs text-text-muted">{r.students?.register_number}</div>
                    </td>
                    <td className="p-4">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_TONE[r.status] ?? 'bg-main text-text-muted'}`}>
                        {r.status.replace('_', ' ')}
                        {r.is_manual && ' *'}
                      </span>
                    </td>
                    <td className="p-4 text-xs text-text-muted">{r.distance_m !== null ? `${r.distance_m.toFixed(1)}m` : '—'}</td>
                    <td className="p-4 text-right">
                      {canOverride && (
                        <button onClick={() => setOverriding(r)} className="text-xs text-accent-primary hover:underline">
                          Override
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {records && records.length === 0 && (
                  <tr><td colSpan={4} className="p-8 text-center text-text-muted text-sm">No eligible students yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {overriding && (
        <OverrideModal
          record={overriding}
          onClose={() => setOverriding(null)}
          onDone={() => {
            setOverriding(null);
            if (selectedSessionId) loadRecords(selectedSessionId);
          }}
        />
      )}
    </div>
  );
};

const StatTile: React.FC<{ label: string; value: number; tone?: string }> = ({ label, value, tone }) => (
  <div className="p-3 bg-main rounded-lg border border-border-default text-center">
    <div className={`text-xl font-bold ${tone ?? 'text-text-primary'}`}>{value}</div>
    <div className="text-[10px] text-text-muted uppercase tracking-wider mt-1">{label}</div>
  </div>
);

const OverrideModal: React.FC<{ record: AttendanceRecord; onClose: () => void; onDone: () => void }> = ({ record, onClose, onDone }) => {
  const { showToast } = useToast();
  const [newStatus, setNewStatus] = useState<'MANUAL_PRESENT' | 'MANUAL_ABSENT'>('MANUAL_PRESENT');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.rpc('override_attendance', {
      p_record_id: record.id,
      p_new_status: newStatus,
      p_reason: reason,
    });
    setSubmitting(false);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast('Attendance overridden.', 'success');
    onDone();
  };

  return (
    <Modal title={`Override — ${record.students?.users?.full_name ?? record.students?.register_number}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        <div className="p-3 bg-main rounded-lg border border-border-default text-sm flex justify-between">
          <span className="text-text-muted">Current status</span>
          <span className="font-medium text-text-primary">{record.status.replace('_', ' ')}</span>
        </div>
        <div>
          <label className="text-xs text-text-muted uppercase font-bold">New Status</label>
          <select
            className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value as typeof newStatus)}
          >
            <option value="MANUAL_PRESENT">Present</option>
            <option value="MANUAL_ABSENT">Absent</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-text-muted uppercase font-bold">Reason (required)</label>
          <textarea
            required
            rows={3}
            className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary resize-none"
            placeholder="e.g. Approved medical leave, verified by HOD."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
          <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
            {submitting ? 'Saving...' : 'Confirm Override'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default AttendancePage;
