import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

/**
 * Small read-only fetch for `<select>` option lists (departments, courses,
 * sections, academic years, ...) used by every Phase 5 create/edit form.
 * Deliberately not routed through useSupabaseTable: option lists need no
 * pagination, search or mutation, just "give me the active rows, once".
 */
export function useLookupOptions<T extends keyof Database['public']['Tables']>(
  table: T,
  columns: string,
  filters?: Record<string, string | number | boolean>
) {
  const [options, setOptions] = useState<Array<Record<string, unknown>>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const filterKey = filters ? JSON.stringify(filters) : '';

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    // See useSupabaseTable.ts's identical comment on the `.eq()` cast: with
    // `table: T` generic rather than a literal, PostgREST's typed builder's
    // column-name overloads degrade to an unhelpful cross-table `keyof`
    // intersection.
    let query = supabase.from(table).select(columns);
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        query = query.eq(key as never, value as never);
      }
    }

    query.then(({ data, error }) => {
      if (cancelled) return;
      if (!error) setOptions((data ?? []) as unknown as Array<Record<string, unknown>>);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, columns, filterKey]);

  return { options, isLoading };
}
