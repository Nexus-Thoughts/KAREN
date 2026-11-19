/**
 * Modal shell, extracted from the repeated pattern in
 * reference/IRIS-PAYROLL-main/components/Dashboard.tsx (Add Employee modal)
 * and EmployeeList.tsx (Add Employee modal): `fixed inset-0 z-50 bg-black/70
 * backdrop-blur-sm` overlay + `bg-panel border rounded-2xl animate-in
 * zoom-in-95` panel + header row with an X button. Every IRIS modal repeats
 * this exact wrapper by hand; this component is that wrapper, so entity forms
 * (Phase 5 onward) only supply the header title and body.
 */
import React from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}

const Modal: React.FC<ModalProps> = ({ title, onClose, children, maxWidth = 'max-w-md' }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in">
    <div className={`bg-panel border border-border-default rounded-2xl w-full ${maxWidth} shadow-2xl animate-in zoom-in-95`}>
      <div className="p-6 border-b border-border-default flex justify-between items-center">
        <h3 className="text-lg font-bold text-text-primary">{title}</h3>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary">
          <X size={20} />
        </button>
      </div>
      {children}
    </div>
  </div>
);

export default Modal;
