/**
 * useDashboardStats — fetches the admin command-center KPI snapshot.
 *
 * Calls get_dashboard_stats() RPC (SECURITY INVOKER) which aggregates
 * institution-wide attendance, class session and department counts for today.
 * All numbers are real — never fabricated. Loading/error states are surfaced
 * so every KPI card can show a skeleton or error indicator.
 *
 * Note: The new RPCs (get_dashboard_stats, get_department_strength,
 * get_today_class_sessions) are added in migration 20260101002700_dashboard_stats.sql.
 * The generated database.ts hasn't been regenerated yet, so we use
 * `supabase.rpc(name as never, ...)` with explicit casts to avoid TS2345.
 * After running `npm run db:types` these casts can be removed.
 */
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export interface DashboardStats {
  total_students: number;
  present_today: number;
  absent_today: number;
  total_records_today: number;
  active_classes_today: number;
  total_classes_today: number;
  active_departments: number;
  active_geofences: number;
  attendance_pct: number;
}

export interface DepartmentStrength {
  department_id: string;
  department_name: string;
  student_count: number;
}

export interface DepartmentAttendance {
  department_id: string | null;
  department_name: string | null;
  present_count: number | null;
  absent_count: number | null;
  total_count: number | null;
  present_rate_pct: number | null;
}

export interface TodaySession {
  session_id: string;
  subject_code: string | null;
  subject_name: string | null;
  section_name: string | null;
  section_year: number | null;
  classroom_name: string | null;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  present_count: number;
  absent_count: number;
  total_count: number;
}

interface UseDashboardStatsResult {
  stats: DashboardStats | null;
  deptStrength: DepartmentStrength[];
  deptAttendance: DepartmentAttendance[];
  todaySessions: TodaySession[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const DEFAULT_STATS: DashboardStats = {
  total_students: 0,
  present_today: 0,
  absent_today: 0,
  total_records_today: 0,
  active_classes_today: 0,
  total_classes_today: 0,
  active_departments: 0,
  active_geofences: 0,
  attendance_pct: 0,
};

export function useDashboardStats(): UseDashboardStatsResult {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [deptStrength, setDeptStrength] = useState<DepartmentStrength[]>([]);
  const [deptAttendance, setDeptAttendance] = useState<DepartmentAttendance[]>([]);
  const [todaySessions, setTodaySessions] = useState<TodaySession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        // New RPCs not yet in database.ts — cast to never to avoid TS2345.
        // Re-run `npm run db:types` after pushing migration to resolve these.
        const [statsRes, strengthRes, attendanceRes, sessionsRes] = await Promise.all([
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase.rpc('get_dashboard_stats' as never) as unknown as Promise<{ data: Record<string, number> | null; error: { message: string } | null }>,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase.rpc('get_department_strength' as never) as unknown as Promise<{ data: DepartmentStrength[] | null; error: { message: string } | null }>,
          supabase.from('report_department_attendance_stats').select('*') as unknown as Promise<{ data: DepartmentAttendance[] | null; error: { message: string } | null }>,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase.rpc('get_today_class_sessions' as never) as unknown as Promise<{ data: TodaySession[] | null; error: { message: string } | null }>,
        ]);

        if (cancelled) return;

        // Stats
        if (statsRes.error) throw new Error(statsRes.error.message);
        const raw = { ...DEFAULT_STATS, ...(statsRes.data ?? {}) } as DashboardStats;
        const presentPct = raw.total_records_today > 0
          ? Math.round((raw.present_today / raw.total_records_today) * 1000) / 10
          : 0;
        setStats({ ...raw, attendance_pct: presentPct });

        // Department strength
        if (strengthRes.error) throw new Error(strengthRes.error.message);
        setDeptStrength(
          (strengthRes.data ?? []).map((d) => ({
            department_id: String(d.department_id ?? ''),
            department_name: String(d.department_name ?? ''),
            student_count: Number(d.student_count ?? 0),
          }))
        );

        // Department attendance (from existing report view)
        if (attendanceRes.error) throw new Error(attendanceRes.error.message);
        setDeptAttendance(attendanceRes.data ?? []);

        // Today's sessions
        if (sessionsRes.error) throw new Error(sessionsRes.error.message);
        const sessions = (sessionsRes.data ?? []);
        setTodaySessions(sessions.map((s) => ({
          session_id: String(s.session_id ?? ''),
          subject_code: s.subject_code ?? null,
          subject_name: s.subject_name ?? null,
          section_name: s.section_name ?? null,
          section_year: s.section_year ? Number(s.section_year) : null,
          classroom_name: s.classroom_name ?? null,
          scheduled_start: String(s.scheduled_start ?? ''),
          scheduled_end: String(s.scheduled_end ?? ''),
          status: String(s.status ?? ''),
          present_count: Number(s.present_count ?? 0),
          absent_count: Number(s.absent_count ?? 0),
          total_count: Number(s.total_count ?? 0),
        })));

      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [tick]);

  return { stats, deptStrength, deptAttendance, todaySessions, isLoading, error, refetch };
}
