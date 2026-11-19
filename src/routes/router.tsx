import React from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RequireAuth, RequireRole } from './ProtectedRoute';
import RoleShell from './RoleShell';
import LoginPage from '@/features/auth/LoginPage';
import DashboardPage from '@/features/dashboard/DashboardPage';
import ModulePlaceholder from './ModulePlaceholder';
import DepartmentsPage from '@/features/academic/DepartmentsPage';
import AcademicStructurePage from '@/features/academic/AcademicStructurePage';
import StudentsPage from '@/features/students/StudentsPage';
import StudentCalendarPage from '@/features/students/StudentCalendarPage';
import MyAttendancePage from '@/features/students/MyAttendancePage';
import FacultyPage from '@/features/faculty/FacultyPage';
import ClassroomsPage from '@/features/classrooms/ClassroomsPage';
import TimetablePage from '@/features/timetable/TimetablePage';
import GeofencingPage from '@/features/geofencing/GeofencingPage';
import AttendancePage from '@/features/attendance/AttendancePage';
import NotificationsPage from '@/features/notifications/NotificationsPage';
import ReportsPage from '@/features/reports/ReportsPage';
import DocumentsPage from '@/features/documents/DocumentsPage';
import KarenChatPage from '@/features/karen/KarenChatPage';
import AuditPage from '@/features/audit/AuditPage';
import SettingsPage from '@/features/settings/SettingsPage';
import { useAuth } from '@/features/auth/AuthProvider';
import { primaryRole } from '@/types/domain';
import type { RoleKey } from '@/types/domain';

/** Resolves `/` and `/dashboard` to the caller's actual role-prefixed home. */
const HomeRedirect: React.FC = () => {
  const { profile } = useAuth();
  if (!profile) return null;
  const role = primaryRole(profile);
  return <Navigate to={role ? `/${role.toLowerCase().replace('_', '-')}/dashboard` : '/login'} replace />;
};

/**
 * Route tree. See docs/22_ARCHITECTURE_DECISIONS.md ADR-002 for why
 * react-router replaces IRIS's useState<ViewState> switch.
 *
 * Each role gets its own path prefix (`/admin`, `/hod`, ...), guarded by
 * RequireRole, wrapped in RoleShell (the ported Layout). Module routes that
 * have not landed yet render ModulePlaceholder rather than mock content.
 */

const roleSections: Array<{ prefix: string; roles: RoleKey[]; moduleIds: string[] }> = [
  { prefix: 'admin', roles: ['ADMIN'], moduleIds: ['students', 'faculty', 'departments', 'academic-structure', 'timetable', 'classrooms', 'geofencing', 'attendance', 'notifications', 'reports', 'documents', 'karen', 'audit', 'settings'] },
  { prefix: 'hod', roles: ['HOD'], moduleIds: ['students', 'faculty', 'departments', 'academic-structure', 'timetable', 'classrooms', 'geofencing', 'attendance', 'notifications', 'reports', 'documents', 'karen'] },
  { prefix: 'faculty', roles: ['FACULTY'], moduleIds: ['students', 'timetable', 'attendance', 'notifications', 'reports', 'documents', 'karen'] },
  { prefix: 'mentor', roles: ['MENTOR'], moduleIds: ['students', 'timetable', 'attendance', 'notifications', 'reports', 'documents', 'karen'] },
  { prefix: 'class-incharge', roles: ['CLASS_INCHARGE'], moduleIds: ['students', 'timetable', 'attendance', 'notifications', 'reports', 'documents', 'karen'] },
  { prefix: 'student', roles: ['STUDENT'], moduleIds: ['my-attendance', 'my-timetable', 'notifications', 'documents', 'karen'] },
];

/** Modules with a real, RLS-backed page. Everything else still renders ModulePlaceholder. */
const moduleComponent: Record<string, React.ComponentType> = {
  students: StudentsPage,
  faculty: FacultyPage,
  departments: DepartmentsPage,
  'academic-structure': AcademicStructurePage,
  timetable: TimetablePage,
  'my-timetable': TimetablePage,
  classrooms: ClassroomsPage,
  geofencing: GeofencingPage,
  attendance: AttendancePage,
  'my-attendance': MyAttendancePage,
  notifications: NotificationsPage,
  reports: ReportsPage,
  documents: DocumentsPage,
  karen: KarenChatPage,
  audit: AuditPage,
  settings: SettingsPage,
};

const modulePhase: Record<string, string> = {};

const moduleLabel: Record<string, string> = {
  students: 'Students', faculty: 'Faculty', departments: 'Departments',
  'academic-structure': 'Academic Structure',
  timetable: 'Timetable', classrooms: 'Classrooms', geofencing: 'Geofencing',
  attendance: 'Attendance', notifications: 'Notifications', reports: 'Reports',
  documents: 'Documents', karen: 'KAREN', audit: 'Audit', settings: 'Settings',
  'my-attendance': 'Attendance', 'my-timetable': 'Timetable',
};

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <HomeRedirect /> },
      { path: '/dashboard', element: <HomeRedirect /> },
      ...roleSections.map((section) => ({
        element: <RequireRole roles={section.roles} />,
        children: [
          {
            path: `/${section.prefix}`,
            element: <RoleShell />,
            children: [
              { index: true, element: <Navigate to="dashboard" replace /> },
              { path: 'dashboard', element: <DashboardPage /> },
              // Student Calendar stays a sub-function of Student Management
              // (explicit, repeated requirement) — reachable only from
              // StudentsPage's own detail view (staff) or MyAttendancePage's
              // redirect (STUDENT's own "my-attendance" nav entry), never
              // from the sidebar directly, so it is not part of
              // moduleIds/moduleComponent below.
              ...(section.moduleIds.includes('students') || section.moduleIds.includes('my-attendance')
                ? [{ path: 'students/calendar/:studentId', element: <StudentCalendarPage /> }]
                : []),
              ...section.moduleIds.map((id) => {
                const Component = moduleComponent[id];
                return {
                  path: id,
                  element: Component ? (
                    <Component />
                  ) : (
                    <ModulePlaceholder title={moduleLabel[id] ?? id} phase={modulePhase[id] ?? 'a future phase'} />
                  ),
                };
              }),
            ],
          },
        ],
      })),
    ],
  },
  { path: '*', element: <Navigate to="/login" replace /> },
]);
