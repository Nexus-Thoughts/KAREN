/**
 * Verbatim port of reference/IRIS-PAYROLL-main/components/Toast.tsx.
 * No payroll-specific content existed in this component, so it is reused
 * unchanged (docs/18_IRIS_REUSE_AND_EXTRACTION_RULES.md, Rule 2).
 */
import React, { createContext, useContext, useState, useCallback } from 'react';
import { X, CheckCircle, AlertTriangle, Info, AlertCircle } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  showToast: (message: string, type: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <div 
            key={toast.id}
            className={`pointer-events-auto flex items-center gap-3 min-w-[320px] max-w-md p-4 rounded-xl shadow-2xl border animate-in slide-in-from-right-full duration-300 backdrop-blur-md ${
              toast.type === 'success' ? 'bg-panel/95 border-status-success/20 text-text-primary' :
              toast.type === 'error' ? 'bg-panel/95 border-status-error/20 text-text-primary' :
              toast.type === 'warning' ? 'bg-panel/95 border-status-warning/20 text-text-primary' :
              'bg-panel/95 border-accent-primary/20 text-text-primary'
            }`}
          >
            <div className={`p-2 rounded-full shrink-0 ${
               toast.type === 'success' ? 'text-status-success bg-status-success/10' :
               toast.type === 'error' ? 'text-status-error bg-status-error/10' :
               toast.type === 'warning' ? 'text-status-warning bg-status-warning/10' :
               'text-accent-primary bg-accent-primary/10'
            }`}>
              {toast.type === 'success' && <CheckCircle size={18} />}
              {toast.type === 'error' && <AlertCircle size={18} />}
              {toast.type === 'warning' && <AlertTriangle size={18} />}
              {toast.type === 'info' && <Info size={18} />}
            </div>
            <p className="text-sm font-medium flex-1 leading-snug">{toast.message}</p>
            <button onClick={() => removeToast(toast.id)} className="text-text-muted hover:text-text-primary p-1 hover:bg-main rounded-full transition-colors">
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};