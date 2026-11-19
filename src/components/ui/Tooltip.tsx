/**
 * Verbatim port of reference/IRIS-PAYROLL-main/components/Tooltip.tsx.
 * No payroll-specific content existed in this component, so it is reused
 * unchanged (docs/18_IRIS_REUSE_AND_EXTRACTION_RULES.md, Rule 2).
 */
import React, { ReactNode } from 'react';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

const Tooltip: React.FC<TooltipProps> = ({ content, children }) => {
  return (
    <div className="group relative inline-flex w-full h-full justify-center">
      {children}
      <div className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-200 absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-panel border border-border-default text-text-primary text-xs rounded-lg shadow-xl z-50 min-w-max pointer-events-none">
        {content}
        <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-border-default"></div>
      </div>
    </div>
  );
};

export default Tooltip;