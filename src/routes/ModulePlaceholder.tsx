import React from 'react';
import { Construction } from 'lucide-react';

/**
 * Deliberately not a fake feature screen. Modules land phase by phase, each
 * complete with schema + API + RLS + UI + tests together (build instructions,
 * "no half-finished phases"). Until a module's phase lands, its route renders
 * this honest placeholder rather than mock data or non-functional buttons —
 * master prompt §55 prohibits exactly that.
 */
const ModulePlaceholder: React.FC<{ title: string; phase: string }> = ({ title, phase }) => (
  <div className="bg-panel border border-border-default rounded-xl p-12 flex flex-col items-center justify-center text-center gap-3 animate-in fade-in duration-500">
    <div className="p-3 rounded-full bg-main border border-border-default text-text-muted">
      <Construction size={24} />
    </div>
    <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
    <p className="text-sm text-text-secondary max-w-md">
      This module has not been implemented yet. It lands in <strong>{phase}</strong> with its full
      schema, API, authorization and tests together — see docs/00_RECONNAISSANCE.md §14.
    </p>
  </div>
);

export default ModulePlaceholder;
