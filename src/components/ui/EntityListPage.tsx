/**
 * Generalised from reference/IRIS-PAYROLL-main/components/EmployeeList.tsx.
 *
 * See docs/22_ARCHITECTURE_DECISIONS.md ADR-005: docs/17 maps five different
 * KAREN screens (Students, Faculty, Subjects, Classrooms, several report
 * views) onto "IRIS list/table pages" — the same DOM structure, table
 * classes, toolbar and pagination controls. Copy-pasting EmployeeList.tsx
 * five times would satisfy "reuse the exact component" literally while
 * creating five copies of the same bug surface. This component preserves
 * every IRIS className string and DOM shape verbatim, parameterised over
 * columns/rows instead of hard-coded employee fields — the *rendered output*
 * for a straight port would be identical to what this produces.
 *
 * Toolbar (search + view toggle + actions), sticky-header table, per-row
 * Tooltip actions, empty state and prev/next pagination are all IRIS's
 * markup. Entity-specific pages (Students, Faculty, ...) supply columns,
 * rows and the create/edit modal content; this component owns none of that.
 */
import React, { useState } from 'react';
import { Search, ChevronLeft, ChevronRight, X, MoreHorizontal, Filter } from 'lucide-react';
import Tooltip from './Tooltip';

export interface EntityColumn<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  render: (row: T) => React.ReactNode;
}

export interface EntityRowAction<T> {
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  onClick: (row: T) => void;
  hidden?: (row: T) => boolean;
  tone?: 'default' | 'danger';
}

interface EntityListPageProps<T> {
  title: string;
  subtitle?: string;
  scopeBadge?: string;
  columns: EntityColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  isSearching?: boolean;
  emptyMessage?: string;
  rowActions?: EntityRowAction<T>[];
  headerActions?: React.ReactNode;
  /**
   * Filter controls (selects) shown behind IRIS's Filter toggle button.
   * EmployeeList.tsx has this exact button already; it was inert there
   * (payroll never implemented filtering). Phase 6 gives it a real target —
   * the toggle behaviour and band styling are new, everything else is IRIS's.
   */
  filters?: React.ReactNode;
  page?: number;
  totalPages?: number;
  totalCount?: number;
  pageSize?: number;
  onNextPage?: () => void;
  onPrevPage?: () => void;
}

function EntityListPage<T>({
  title,
  subtitle,
  scopeBadge,
  columns,
  rows,
  rowKey,
  searchQuery,
  onSearchChange,
  searchPlaceholder = 'Search...',
  isSearching = false,
  emptyMessage = 'No records found.',
  rowActions = [],
  headerActions,
  filters,
  page,
  totalPages,
  totalCount,
  pageSize,
  onNextPage,
  onPrevPage,
}: EntityListPageProps<T>) {
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const [showFilters, setShowFilters] = useState(false);
  const showPagination = page !== undefined && totalPages !== undefined && !searchQuery;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h2 className="text-2xl font-bold text-text-primary flex items-center gap-3">
            {title}
            {scopeBadge && (
              <span className="px-3 py-1 bg-accent-secondary/10 border border-accent-secondary/30 text-accent-secondary text-xs rounded-full font-medium">
                {scopeBadge}
              </span>
            )}
          </h2>
          {subtitle && <p className="text-text-secondary mt-1">{subtitle}</p>}
        </div>
        {headerActions && <div className="flex flex-wrap gap-3 w-full md:w-auto">{headerActions}</div>}
      </div>

      <div className="bg-panel border border-border-default rounded-xl overflow-hidden flex flex-col min-h-[400px]">
        <div className="p-4 border-b border-border-default bg-main/30 flex flex-col sm:flex-row gap-4 justify-between items-center">
          <div className="relative w-full sm:max-w-md">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={localQuery}
              onChange={(e) => {
                setLocalQuery(e.target.value);
                onSearchChange(e.target.value);
              }}
              placeholder={searchPlaceholder}
              className="w-full bg-main border border-border-default rounded-lg pl-10 pr-10 py-2 text-sm text-text-primary focus:border-accent-primary outline-none transition-colors"
            />
            {localQuery && (
              <button
                onClick={() => {
                  setLocalQuery('');
                  onSearchChange('');
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
            {filters && (
              <button
                onClick={() => setShowFilters((v) => !v)}
                className={`flex items-center gap-2 px-4 py-2 border rounded-lg transition-colors hover:scale-105 active:scale-95 ${
                  showFilters
                    ? 'bg-accent-primary/10 border-accent-primary text-accent-primary'
                    : 'bg-panel border-border-default text-text-secondary hover:text-text-primary'
                }`}
              >
                <Filter size={16} /> <span className="hidden sm:inline">Filter</span>
              </button>
            )}
            <div className="text-xs text-text-muted flex items-center gap-2">
              {searchQuery ? (
                <span>Found {rows.length} results</span>
              ) : totalCount !== undefined && page !== undefined && pageSize !== undefined ? (
                <span>
                  Showing {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, totalCount)} of{' '}
                  {totalCount.toLocaleString()}
                </span>
              ) : (
                <span>{rows.length} records</span>
              )}
            </div>
          </div>
        </div>

        {filters && showFilters && (
          <div className="p-4 border-b border-border-default bg-main/20 flex flex-wrap gap-3 items-end animate-in fade-in slide-in-from-top-1 duration-150">
            {filters}
          </div>
        )}

        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left min-w-[800px]">
            <thead>
              <tr className="bg-main/50 text-text-muted text-xs uppercase tracking-wider sticky top-0 backdrop-blur-md z-10">
                {columns.map((col) => (
                  <th key={col.key} className={`p-4 font-medium ${col.align === 'right' ? 'text-right' : ''}`}>
                    {col.header}
                  </th>
                ))}
                {rowActions.length > 0 && <th className="p-4 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {rows.map((row) => (
                <tr key={rowKey(row)} className="hover:bg-main/50 transition-colors group">
                  {columns.map((col) => (
                    <td key={col.key} className={`p-4 ${col.align === 'right' ? 'text-right' : ''}`}>
                      {col.render(row)}
                    </td>
                  ))}
                  {rowActions.length > 0 && (
                    <td className="p-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {rowActions
                          .filter((a) => !a.hidden?.(row))
                          .map((action) => (
                            <Tooltip key={action.label} content={action.label}>
                              <button
                                onClick={() => action.onClick(row)}
                                aria-label={action.label}
                                className={`p-1 transition-colors ${
                                  action.tone === 'danger'
                                    ? 'text-text-muted hover:text-status-error'
                                    : 'text-text-muted hover:text-accent-primary'
                                }`}
                              >
                                <action.icon size={16} />
                              </button>
                            </Tooltip>
                          ))}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (rowActions.length > 0 ? 1 : 0)} className="p-12 text-center text-text-muted">
                    {isSearching ? 'Searching...' : emptyMessage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {showPagination && (
          <div className="p-4 border-t border-border-default bg-main/30 flex justify-between items-center">
            <button
              onClick={onPrevPage}
              disabled={page === 1}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border-default text-sm text-text-secondary hover:text-text-primary hover:border-accent-primary disabled:opacity-50 disabled:hover:border-border-default transition-all"
            >
              <ChevronLeft size={16} /> Previous
            </button>
            <span className="text-sm text-text-secondary">
              Page <span className="text-text-primary font-bold">{page}</span> of {totalPages!.toLocaleString()}
            </span>
            <button
              onClick={onNextPage}
              disabled={page === totalPages}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border-default text-sm text-text-secondary hover:text-text-primary hover:border-accent-primary disabled:opacity-50 disabled:hover:border-border-default transition-all"
            >
              Next <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default EntityListPage;
export { MoreHorizontal };
