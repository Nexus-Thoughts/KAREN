import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

/**
 * Real-time notification feed for the signed-in user. Backs both the
 * Layout bell dropdown (last 10) and the full NotificationsPage inbox.
 *
 * Initial load is a plain PostgREST query (RLS-scoped to
 * `recipient_id = auth.uid()` — supabase/migrations/20260101001800); after
 * that, a Supabase Realtime `postgres_changes` subscription on the same
 * table keeps the list live without polling. Realtime's own broadcast is
 * itself RLS-scoped per-connection, so this subscription can only ever
 * receive rows this user is already allowed to SELECT — no separate access
 * check is needed here, mirroring useSupabaseTable's reasoning.
 */
export type NotificationRow = Database['public']['Tables']['notifications']['Row'];

export function useNotifications(userId: string | null, limit = 20) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    setRows(data ?? []);
    setIsLoading(false);
  }, [userId, limit]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        () => void refetch()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, refetch]);

  const unreadCount = rows.filter((r) => !r.read_at).length;

  const markRead = useCallback(async (id: string) => {
    await supabase.rpc('mark_notification_read', { p_id: id });
    void refetch();
  }, [refetch]);

  const markAllRead = useCallback(async () => {
    await supabase.rpc('mark_all_notifications_read');
    void refetch();
  }, [refetch]);

  return { rows, isLoading, unreadCount, markRead, markAllRead, refetch };
}
