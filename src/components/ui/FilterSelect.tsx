/**
 * One filter dropdown, styled to match the form `<select>`s already used
 * throughout Phase 5 (docs/18 Rule 2 — no new visual pattern). Rendered
 * inside EntityListPage's `filters` slot.
 */
import React from 'react';

interface FilterSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}

const FilterSelect: React.FC<FilterSelectProps> = ({ label, value, onChange, options, placeholder = 'All' }) => (
  <div className="min-w-[160px]">
    <label className="text-[10px] text-text-muted uppercase font-bold tracking-wider block mb-1">{label}</label>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary transition-colors"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </div>
);

export default FilterSelect;
