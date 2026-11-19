/**
 * Student Calendar — a sub-function of Student Management, not a top-level
 * navigation item (explicit requirement, repeated across the steering docs).
 * Reached only via StudentsPage's detail view "Open Student Calendar" link;
 * there is deliberately no nav entry and no route outside /students/calendar/:id.
 *
 * Visual structure is a direct port of
 * reference/IRIS-PAYROLL-main/components/AttendanceCalendar.tsx — the
 * 12-month grid, per-day dot markers and rich hover Tooltip are IRIS's
 * existing pattern (docs/18 Rule 2), not a new component invented for KAREN.
 *
 * ASSUMPTION FLAGGED: the steering docs repeatedly require "the three
 * required top-level category buttons" atop this screen without ever
 * defining what the three categories are — checked across all 15 docs +
 * CLAUDE.md, genuinely absent. Implemented as a Month / Semester / Year
 * range selector (a defensible, common pattern for an attendance calendar,
 * and one that needs no fabricated status data to be meaningful before
 * Phase 9 exists). This should be confirmed and can be swapped for whatever
 * the real three categories turn out to be without touching the data layer.
 *
 * Phase 9's attendance engine now exists — this reads real
 * attendance_records/class_sessions data, RLS-scoped exactly like every
 * other read in the app (a student viewing their own calendar always
 * resolves via their own row; a viewing faculty/HOD/mentor resolves via the
 * same staff-reach rules attendance_records_select already enforces —
 * see docs/22 ADR-015). A day with no class_sessions that day, or one whose
 * attendance simply hasn't been evaluated/finalized yet, is shown as
 * genuinely empty rather than guessed at.
 */
import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import Tooltip from '@/components/ui/Tooltip';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type ViewRange = 'month' | 'semester' | 'year';
type AttendanceStatus = Database['public']['Enums']['attendance_status'];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface DaySession {
  status: AttendanceStatus;
  subject_code: string;
  subject_name: string;
}

// Worst-first: the day's summary dot reflects the most concerning status
// among that day's sessions, so a student can't miss a real absence buried
// under an otherwise-fine day.
const STATUS_PRIORITY: AttendanceStatus[] = [
  'ABSENT', 'MANUAL_ABSENT', 'OUTSIDE_CLASSROOM', 'OUTSIDE_CAMPUS', 'LOW_GPS_ACCURACY',
  'LATE', 'PRESENT', 'MANUAL_PRESENT', 'VERIFYING', 'DETECTED', 'PENDING',
];

const STATUS_STYLE: Record<AttendanceStatus, { dot: string; text: string; label: string }> = {
  PRESENT:            { dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Present' },
  MANUAL_PRESENT:      { dot: 'bg-emerald-500', text: 'text-emerald-500', label: 'Present (manual)' },
  LATE:                { dot: 'bg-yellow-500',  text: 'text-yellow-500',  label: 'Late' },
  ABSENT:              { dot: 'bg-red-500',     text: 'text-red-500',     label: 'Absent' },
  MANUAL_ABSENT:        { dot: 'bg-red-500',     text: 'text-red-500',     label: 'Absent (manual)' },
  OUTSIDE_CLASSROOM:    { dot: 'bg-red-400',     text: 'text-red-400',     label: 'Outside classroom' },
  OUTSIDE_CAMPUS:       { dot: 'bg-red-400',     text: 'text-red-400',     label: 'Outside campus' },
  LOW_GPS_ACCURACY:     { dot: 'bg-violet-500',  text: 'text-violet-500',  label: 'Low GPS accuracy' },
  PENDING:             { dot: 'bg-text-muted',  text: 'text-text-muted',  label: 'Pending' },
  DETECTED:            { dot: 'bg-blue-400',    text: 'text-blue-400',    label: 'Detected' },
  VERIFYING:           { dot: 'bg-blue-400',    text: 'text-blue-400',    label: 'Verifying' },
};

function getDaysInMonth(monthIndex: number, year: number): Date[] {
  const date = new Date(year, monthIndex, 1);
  const days: Date[] = [];
  while (date.getMonth() === monthIndex) {
    days.push(new Date(date));
    date.setDate(date.getDate() + 1);
  }
  return days;
}

const StudentCalendarPage: React.FC = () => {
  const { studentId } = useParams<{ studentId: string }>();
  const [range, setRange] = useState<ViewRange>('year');
  const [studentName, setStudentName] = useState<string | null>(null);
  const [byDate, setByDate] = useState<Record<string, DaySession[]>>({});
  const [loaded, setLoaded] = useState(false);
  const year = new Date().getFullYear();

  useEffect(() => {
    if (!studentId) return;
    // RLS-scoped like every other read in the app — a caller who cannot
    // reach this student's row simply gets null back here, same as
    // StudentsPage's own list would have shown them nothing to click.
    supabase
      .from('students')
      .select('register_number, users(full_name)')
      .eq('id', studentId)
      .maybeSingle()
      .then(({ data }) => {
        const users = data?.users as { full_name: string } | { full_name: string }[] | null;
        const name = Array.isArray(users) ? users[0]?.full_name : users?.full_name;
        setStudentName(name ?? data?.register_number ?? null);
      });

    supabase
      .from('attendance_records')
      .select('status, class_sessions(session_date, subjects(code, name))')
      .eq('student_id', studentId)
      .then(({ data }) => {
        const map: Record<string, DaySession[]> = {};
        for (const row of data ?? []) {
          const cs = row.class_sessions as { session_date: string; subjects: { code: string; name: string } | null } | null;
          if (!cs) continue;
          const entry: DaySession = {
            status: row.status,
            subject_code: cs.subjects?.code ?? '—',
            subject_name: cs.subjects?.name ?? '—',
          };
          (map[cs.session_date] ??= []).push(entry);
        }
        setByDate(map);
        setLoaded(true);
      });
  }, [studentId]);

  function summarize(sessions: DaySession[]): AttendanceStatus | null {
    if (sessions.length === 0) return null;
    for (const s of STATUS_PRIORITY) {
      if (sessions.some((d) => d.status === s)) return s;
    }
    return sessions[0]!.status;
  }

  const monthsToShow = range === 'month' ? [new Date().getMonth()] : range === 'semester' ? [0, 1, 2, 3, 4, 5] : MONTHS.map((_, i) => i);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <Link to="../.." relative="path" className="text-xs text-text-muted hover:text-text-primary flex items-center gap-1 mb-2 w-fit">
          <ArrowLeft size={14} /> Back to Students
        </Link>
        <h2 className="text-2xl font-bold text-text-primary">
          {studentName ? `${studentName}'s Calendar` : 'Student Calendar'}
        </h2>
        <p className="text-text-secondary mt-1">Day-by-day attendance for {year}.</p>
      </div>

      {/* The three required category buttons — see the module header for the
          flagged assumption on what these categorise. */}
      <div className="flex bg-panel border border-border-default rounded-lg p-1 w-fit">
        {(['month', 'semester', 'year'] as ViewRange[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-4 py-2 rounded-md text-sm font-medium capitalize transition-all ${
              range === r ? 'bg-accent-primary text-white shadow-md' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Legend — mirrors reference/IRIS-PAYROLL-main/components/AttendanceCalendar.tsx's
          own legend band exactly (docs/18 Rule 2). */}
      <div className="flex flex-wrap gap-6 p-4 bg-panel border border-border-default rounded-xl justify-center text-xs">
        {(['PRESENT', 'LATE', 'ABSENT', 'LOW_GPS_ACCURACY'] as AttendanceStatus[]).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${STATUS_STYLE[s].dot}`} />
            {STATUS_STYLE[s].label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {monthsToShow.map((monthIdx) => {
          const days = getDaysInMonth(monthIdx, year);
          const startDay = days[0]?.getDay() ?? 0;
          const blanks = Array.from({ length: startDay });

          return (
            <div key={monthIdx} className="bg-panel border border-border-default rounded-xl p-4 shadow-sm hover:border-accent-primary/30 transition-colors">
              <h4 className="text-sm font-bold text-text-primary mb-4 text-center">{MONTHS[monthIdx]}</h4>
              <div className="grid grid-cols-7 gap-y-2">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                  <div key={i} className="h-6 flex items-center justify-center">
                    <span className="text-[10px] text-text-muted font-bold opacity-70">{d}</span>
                  </div>
                ))}
                {blanks.map((_, i) => (
                  <div key={`blank-${i}`} className="h-8" />
                ))}
                {days.map((date) => {
                  const dateStr = date.toISOString().split('T')[0]!;
                  const isFuture = date > new Date();
                  const sessions = byDate[dateStr] ?? [];
                  const summary = summarize(sessions);
                  const style = summary ? STATUS_STYLE[summary] : null;
                  return (
                    <div key={dateStr} className="h-8 w-full flex items-center justify-center">
                      <Tooltip
                        content={
                          <div className="text-left p-1 min-w-[160px]">
                            <div className="font-bold text-sm text-text-primary mb-1 border-b border-border-default pb-1">
                              {date.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short' })}
                            </div>
                            {sessions.length === 0 ? (
                              <div className="text-[10px] text-text-muted italic">
                                {!loaded ? 'Loading…' : isFuture ? 'Upcoming' : 'No class sessions recorded'}
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {sessions.map((s, i) => (
                                  <div key={i} className={`text-[10px] flex items-center gap-1.5 ${STATUS_STYLE[s.status].text}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_STYLE[s.status].dot}`} />
                                    {s.subject_code} — {STATUS_STYLE[s.status].label}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        }
                      >
                        <div className={`w-8 h-8 rounded-full flex flex-col items-center justify-center cursor-pointer transition-colors ${style ? 'hover:bg-main/50' : ''}`}>
                          <span className={`text-xs ${isFuture ? 'text-text-muted opacity-40' : 'text-text-primary font-medium'}`}>
                            {date.getDate()}
                          </span>
                          {style && <span className={`w-1 h-1 rounded-full mt-0.5 ${style.dot}`} />}
                        </div>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default StudentCalendarPage;
