/**
 * Phase 21 (Production Readiness) — Settings.
 *
 * Institution-wide configuration, not per-record data: attendance_config
 * and presence_config are both deliberately single-row tables (see their
 * migrations' `_single_row_idx`) — this is the one screen that edits them.
 * Both already carry `updated_by`/`updated_at` and an `after update` audit
 * trigger (cims.audit_row_change), so every change here lands in the Audit
 * Center automatically; this page adds no new backend surface, only a form
 * over two tables and RLS that already require `config.write`
 * (supabase/migrations/20260101001600, 20260101001800).
 */
import React, { useEffect, useState } from 'react';
import { Settings as SettingsIcon, Save, Loader2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import { useToast } from '@/components/ui/Toast';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type AttendanceConfig = Database['public']['Tables']['attendance_config']['Row'];
type PresenceConfig = Database['public']['Tables']['presence_config']['Row'];

const FieldLabel: React.FC<{ children: React.ReactNode; hint?: string }> = ({ children, hint }) => (
  <div>
    <label className="text-xs text-text-muted uppercase font-bold">{children}</label>
    {hint && <p className="text-[11px] text-text-muted mt-0.5">{hint}</p>}
  </div>
);

const numberInput = 'w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary';

const SettingsPage: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'config.write');

  const [loading, setLoading] = useState(true);
  const [attendance, setAttendance] = useState<AttendanceConfig | null>(null);
  const [presence, setPresence] = useState<PresenceConfig | null>(null);
  const [savingAttendance, setSavingAttendance] = useState(false);
  const [savingPresence, setSavingPresence] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: a }, { data: p }] = await Promise.all([
        supabase.from('attendance_config').select('*').maybeSingle(),
        supabase.from('presence_config').select('*').maybeSingle(),
      ]);
      if (cancelled) return;
      setAttendance(a);
      setPresence(p);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveAttendance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attendance) return;
    setSavingAttendance(true);
    const { error } = await supabase
      .from('attendance_config')
      .update({
        grace_period_minutes: attendance.grace_period_minutes,
        late_window_minutes: attendance.late_window_minutes,
        attendance_window_after_minutes: attendance.attendance_window_after_minutes,
        location_accuracy_threshold_m: attendance.location_accuracy_threshold_m,
        min_confirmations_required: attendance.min_confirmations_required,
      })
      .eq('id', attendance.id);
    setSavingAttendance(false);
    showToast(error ? error.message : 'Attendance thresholds saved.', error ? 'error' : 'success');
  };

  const savePresence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!presence) return;
    setSavingPresence(true);
    const { error } = await supabase
      .from('presence_config')
      .update({
        college_start_time: presence.college_start_time,
        college_end_time: presence.college_end_time,
        exit_confirmation_samples: presence.exit_confirmation_samples,
        reentry_confirmation_samples: presence.reentry_confirmation_samples,
      })
      .eq('id', presence.id);
    setSavingPresence(false);
    showToast(error ? error.message : 'Presence / early-exit thresholds saved.', error ? 'error' : 'success');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted text-sm gap-2">
        <Loader2 size={16} className="animate-spin" /> Loading settings...
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-3xl">
      <div className="flex items-center gap-2">
        <SettingsIcon className="w-6 h-6 text-accent-primary" />
        <div>
          <h2 className="text-2xl font-bold text-text-primary">Settings</h2>
          <p className="text-text-secondary mt-1">Institution-wide attendance and presence thresholds. Every change here is audited.</p>
        </div>
      </div>

      {!canWrite && (
        <div className="p-3 bg-status-warning/10 border border-status-warning/20 rounded-lg text-status-warning text-sm">
          You can view these settings but not change them — editing requires the config.write permission (Admin).
        </div>
      )}

      {attendance && (
        <form onSubmit={saveAttendance} className="bg-panel border border-border-default rounded-2xl p-6 space-y-4">
          <h3 className="font-semibold text-text-primary">Attendance Engine</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <FieldLabel hint="Minutes after class start still counted as on-time.">Grace period (min)</FieldLabel>
              <input type="number" min={0} disabled={!canWrite} className={numberInput} value={attendance.grace_period_minutes}
                onChange={(e) => setAttendance({ ...attendance, grace_period_minutes: Number(e.target.value) })} />
            </div>
            <div>
              <FieldLabel hint="Minutes after the grace period still counted as LATE, not ABSENT.">Late window (min)</FieldLabel>
              <input type="number" min={0} disabled={!canWrite} className={numberInput} value={attendance.late_window_minutes}
                onChange={(e) => setAttendance({ ...attendance, late_window_minutes: Number(e.target.value) })} />
            </div>
            <div>
              <FieldLabel hint="How long past scheduled end the attendance window stays open.">Attendance window after (min)</FieldLabel>
              <input type="number" min={0} disabled={!canWrite} className={numberInput} value={attendance.attendance_window_after_minutes}
                onChange={(e) => setAttendance({ ...attendance, attendance_window_after_minutes: Number(e.target.value) })} />
            </div>
            <div>
              <FieldLabel hint="GPS samples less accurate than this are flagged LOW_GPS_ACCURACY.">Location accuracy threshold (m)</FieldLabel>
              <input type="number" min={1} disabled={!canWrite} className={numberInput} value={attendance.location_accuracy_threshold_m}
                onChange={(e) => setAttendance({ ...attendance, location_accuracy_threshold_m: Number(e.target.value) })} />
            </div>
            <div>
              <FieldLabel hint="Consecutive in-range samples required before marking PRESENT.">Min confirmations required</FieldLabel>
              <input type="number" min={1} disabled={!canWrite} className={numberInput} value={attendance.min_confirmations_required}
                onChange={(e) => setAttendance({ ...attendance, min_confirmations_required: Number(e.target.value) })} />
            </div>
          </div>
          {canWrite && (
            <button type="submit" disabled={savingAttendance} className="px-5 py-2.5 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all flex items-center gap-2 disabled:opacity-50">
              <Save size={16} /> {savingAttendance ? 'Saving...' : 'Save'}
            </button>
          )}
        </form>
      )}

      {presence && (
        <form onSubmit={savePresence} className="bg-panel border border-border-default rounded-2xl p-6 space-y-4">
          <h3 className="font-semibold text-text-primary">Presence / Early-Exit Monitoring</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <FieldLabel>College start time</FieldLabel>
              <input type="time" disabled={!canWrite} className={numberInput} value={presence.college_start_time?.slice(0, 5)}
                onChange={(e) => setPresence({ ...presence, college_start_time: e.target.value })} />
            </div>
            <div>
              <FieldLabel>College end time</FieldLabel>
              <input type="time" disabled={!canWrite} className={numberInput} value={presence.college_end_time?.slice(0, 5)}
                onChange={(e) => setPresence({ ...presence, college_end_time: e.target.value })} />
            </div>
            <div>
              <FieldLabel hint="Consecutive outside-campus samples before a confirmed exit is recorded.">Exit confirmation samples</FieldLabel>
              <input type="number" min={1} disabled={!canWrite} className={numberInput} value={presence.exit_confirmation_samples}
                onChange={(e) => setPresence({ ...presence, exit_confirmation_samples: Number(e.target.value) })} />
            </div>
            <div>
              <FieldLabel hint="Consecutive inside-campus samples before a re-entry is recorded.">Re-entry confirmation samples</FieldLabel>
              <input type="number" min={1} disabled={!canWrite} className={numberInput} value={presence.reentry_confirmation_samples}
                onChange={(e) => setPresence({ ...presence, reentry_confirmation_samples: Number(e.target.value) })} />
            </div>
          </div>
          {canWrite && (
            <button type="submit" disabled={savingPresence} className="px-5 py-2.5 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all flex items-center gap-2 disabled:opacity-50">
              <Save size={16} /> {savingPresence ? 'Saving...' : 'Save'}
            </button>
          )}
        </form>
      )}
    </div>
  );
};

export default SettingsPage;
