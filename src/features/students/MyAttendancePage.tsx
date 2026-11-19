/**
 * STUDENT role's "my attendance" nav entry. Not a separate implementation —
 * a student's own attendance IS the Student Calendar
 * (StudentCalendarPage), which already renders real attendance_records via
 * RLS's self-row path. This just resolves the caller's own student_id and
 * redirects into that same component, rather than building a second
 * attendance view with its own data-fetching logic to keep in sync.
 */
import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthProvider';

const MyAttendancePage: React.FC = () => {
  const { profile } = useAuth();
  if (!profile) return null;
  if (!profile.student_id) {
    return (
      <div className="p-12 bg-panel border border-border-default rounded-xl text-center text-text-muted text-sm">
        No student record is linked to this account.
      </div>
    );
  }
  return <Navigate to={`../students/calendar/${profile.student_id}`} relative="path" replace />;
};

export default MyAttendancePage;
