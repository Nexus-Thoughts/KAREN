import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

/**
 * Generic list+search+paginate+mutate hook over one `public` table.
 *
 * IRIS's EmployeeList.tsx (reference/IRIS-PAYROLL-main/components/EmployeeList.tsx)
 * called synchronous in-memory mock functions (`getEmployeesPage`,
 * `searchEmployees`) directly from the component. Phase 5 replaces that data
 * source with real PostgREST queries, but every KAREN list page — Departments,
 * Courses, Sections, Subjects, Students, Faculty — needs the same shape of
 * state machine around it: loading/empty/error, a debounced search, and
 * offset pagination. Writing that eight times would violate the same
 * "don't copy-paste the bug surface" reasoning as EntityListPage
 * (docs/22_ARCHITECTURE_DECISIONS.md ADR-005); this hook is that shared
 * machine, parameterised over the table and the searchable columns.
 *
 * This performs no authorization decisions of its own — every query goes
 * through the anon-key client, so RLS (supabase/migrations/20260101000700_rls_policies.sql)
 * is what actually determines which rows come back. A caller who lacks scope
 * for a table simply gets fewer/zero rows, exactly as a direct PostgREST call
 * would; there is no separate "can I see this" check to keep in sync.
 */

type TableName = keyof Database['public']['Tables'];
type Row<T extends TableName> = Database['public']['Tables'][T]['Row'];
type Insert<T extends TableName> = Database['public']['Tables'][T]['Insert'];
type Update<T extends TableName> = Database['public']['Tables'][T]['Update'];

export interface UseSupabaseTableOptions {
  /** Postgrest `select()` string. Defaults to `*`. Use for joined columns, e.g. `*, departments(name)`. */
  select?: string;
  /** Columns tried with `ilike` when `searchQuery` is non-empty, OR'd together. */
  searchColumns?: string[];
  pageSize?: number;
  /** Extra filters applied to every query (e.g. `{ department_id: scopedDeptId }`). */
  filters?: Record<string, string | number | boolean>;
  orderBy?: { column: string; ascending?: boolean };
  /** Skip fetching entirely — used while a required filter value (e.g. scope) is not yet known. */
  enabled?: boolean;
}

export interface UseSupabaseTableResult<T extends TableName, TRow = Row<T>> {
  rows: TRow[];
  isLoading: boolean;
  isSearching: boolean;
  error: string | null;
  page: number;
  totalPages: number;
  totalCount: number;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  nextPage: () => void;
  prevPage: () => void;
  refetch: () => Promise<void>;
  insert: (values: Insert<T>) => Promise<{ error: string | null }>;
  update: (id: string, values: Update<T>) => Promise<{ error: string | null }>;
}

export function useSupabaseTable<T extends TableName, TRow = Row<T>>(
  table: T,
  options: UseSupabaseTableOptions = {}
): UseSupabaseTableResult<T, TRow> {
  const { select = '*', searchColumns = [], pageSize = 50, filters, orderBy, enabled = true } = options;

  const [rows, setRows] = useState<TRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [searchQuery, setSearchQueryState] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce so every keystroke doesn't fire a request — IRIS used a raw
  // 300ms setTimeout in EmployeeList.tsx for the same reason.
  useEffect(() => {
    setIsSearching(searchQuery !== debouncedQuery && searchQuery.length > 0);
    const handle = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(handle);
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterKey = filters ? JSON.stringify(filters) : '';

  const fetchPage = useCallback(async () => {
    if (!enabled) {
      setRows([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);

    let query = supabase.from(table).select(select, { count: 'exact' });

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        // PostgREST's typed builder can only statically know column names
        // when the table name itself is a literal; `table: T` here is a
        // generic type parameter, so the filter-column overloads degrade to
        // an unhelpful `keyof` intersection across every table in the
        // schema. `key` is a real column name at every call site (see each
        // page's `filters` prop) — this cast matches how insert()/update()
        // below already handle the same generic-table limitation.
        query = query.eq(key as never, value as never);
      }
    }

    if (debouncedQuery && searchColumns.length > 0) {
      const orClause = searchColumns.map((col) => `${col}.ilike.%${debouncedQuery}%`).join(',');
      query = query.or(orClause);
    }

    if (orderBy) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending ?? true });
    }

    if (!debouncedQuery) {
      const from = (page - 1) * pageSize;
      query = query.range(from, from + pageSize - 1);
    }

    const { data, error: queryError, count } = await query;

    if (queryError) {
      setError(queryError.message);
      setRows([]);
    } else {
      setRows((data ?? []) as unknown as TRow[]);
      setTotalCount(count ?? 0);
    }
    setIsLoading(false);
    setIsSearching(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, select, page, pageSize, debouncedQuery, filterKey, enabled, orderBy?.column, orderBy?.ascending]);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  // A new search resets pagination — otherwise "page 3" could carry over
  // into a filtered result set with only one page of matches.
  useEffect(() => {
    setPage(1);
  }, [debouncedQuery]);

  const insert = useCallback(
    async (values: Insert<T>) => {
      const { error: insertError } = await supabase.from(table).insert(values as never);
      if (insertError) return { error: insertError.message };
      await fetchPage();
      return { error: null };
    },
    [table, fetchPage]
  );

  const update = useCallback(
    async (id: string, values: Update<T>) => {
      const { error: updateError } = await supabase
        .from(table)
        .update(values as never)
        .eq('id' as never, id as never);
      if (updateError) return { error: updateError.message };
      await fetchPage();
      return { error: null };
    },
    [table, fetchPage]
  );

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return {
    rows,
    isLoading,
    isSearching,
    error,
    page,
    totalPages,
    totalCount,
    searchQuery,
    setSearchQuery: setSearchQueryState,
    nextPage: () => setPage((p) => Math.min(p + 1, totalPages)),
    prevPage: () => setPage((p) => Math.max(p - 1, 1)),
    refetch: fetchPage,
    insert,
    update,
  };
}
