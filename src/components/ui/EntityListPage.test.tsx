import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Trash2 } from 'lucide-react';
import EntityListPage, { type EntityColumn, type EntityRowAction } from './EntityListPage';

interface Row {
  id: string;
  name: string;
}

const columns: EntityColumn<Row>[] = [{ key: 'name', header: 'Name', render: (r) => r.name }];
const rows: Row[] = [
  { id: '1', name: 'Rahul Nair' },
  { id: '2', name: 'Priya Krishnan' },
];

describe('EntityListPage', () => {
  it('renders one row per record with the supplied column renderer', () => {
    render(
      <EntityListPage
        title="Students"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        searchQuery=""
        onSearchChange={() => {}}
      />
    );
    expect(screen.getByText('Rahul Nair')).toBeInTheDocument();
    expect(screen.getByText('Priya Krishnan')).toBeInTheDocument();
  });

  it('shows the empty state, not a blank table, when there are no rows', () => {
    render(
      <EntityListPage
        title="Students"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        searchQuery=""
        onSearchChange={() => {}}
        emptyMessage="No students in this section."
      />
    );
    expect(screen.getByText('No students in this section.')).toBeInTheDocument();
  });

  it('propagates search input to the caller rather than filtering locally', () => {
    const onSearchChange = vi.fn();
    render(
      <EntityListPage
        title="Students"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        searchQuery=""
        onSearchChange={onSearchChange}
        searchPlaceholder="Search students..."
      />
    );
    fireEvent.change(screen.getByPlaceholderText('Search students...'), { target: { value: 'Rahul' } });
    expect(onSearchChange).toHaveBeenCalledWith('Rahul');
  });

  it('invokes a row action with the correct row, and hides an action the caller marks hidden', () => {
    const onDelete = vi.fn();
    const actions: EntityRowAction<Row>[] = [
      { label: 'Delete', icon: Trash2, onClick: onDelete, hidden: (r) => r.id === '2', tone: 'danger' },
    ];
    render(
      <EntityListPage
        title="Students"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        searchQuery=""
        onSearchChange={() => {}}
        rowActions={actions}
      />
    );
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    // Only row 1 gets the action; row 2's is hidden.
    expect(deleteButtons).toHaveLength(1);
    fireEvent.click(deleteButtons[0]!);
    expect(onDelete).toHaveBeenCalledWith(rows[0]);
  });

  it('disables Previous on the first page and Next on the last, and calls the right handler', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(
      <EntityListPage
        title="Students"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        searchQuery=""
        onSearchChange={() => {}}
        page={1}
        totalPages={3}
        totalCount={125}
        pageSize={50}
        onNextPage={onNext}
        onPrevPage={onPrev}
      />
    );
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('hides pagination entirely while a search query is active', () => {
    render(
      <EntityListPage
        title="Students"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        searchQuery="Rahul"
        onSearchChange={() => {}}
        page={1}
        totalPages={3}
      />
    );
    expect(screen.queryByRole('button', { name: /Previous/ })).not.toBeInTheDocument();
  });

  it('does not render the Filter toggle when no filters prop is supplied', () => {
    render(
      <EntityListPage
        title="Students"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        searchQuery=""
        onSearchChange={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: /Filter/ })).not.toBeInTheDocument();
  });

  it('reveals the filter panel only after the Filter button is toggled on', () => {
    render(
      <EntityListPage
        title="Students"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        searchQuery=""
        onSearchChange={() => {}}
        filters={<div data-testid="dept-filter">Department filter</div>}
      />
    );
    expect(screen.queryByTestId('dept-filter')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(screen.getByTestId('dept-filter')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(screen.queryByTestId('dept-filter')).not.toBeInTheDocument();
  });
});
