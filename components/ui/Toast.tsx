
import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  exiting?: boolean;
}

interface ToastContextValue {
  showToast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

const TOAST_DURATION = 4000;
const EXIT_ANIMATION_MS = 300;

const typeStyles: Record<ToastType, { bg: string; border: string; icon: React.ReactNode }> = {
  success: {
    bg: 'bg-white',
    border: 'border-l-4 border-l-primary_4',
    icon: <CheckCircle size={18} className="text-primary_4 flex-shrink-0" />,
  },
  error: {
    bg: 'bg-white',
    border: 'border-l-4 border-l-primary_2',
    icon: <XCircle size={18} className="text-primary_2 flex-shrink-0" />,
  },
  info: {
    bg: 'bg-white',
    border: 'border-l-4 border-l-primary_3',
    icon: <Info size={18} className="text-primary_3 flex-shrink-0" />,
  },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    // Mark as exiting first for animation
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, EXIT_ANIMATION_MS);
  }, []);

  const showToast = useCallback((type: ToastType, message: string) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts(prev => [...prev, { id, type, message }]);

    const timer = setTimeout(() => {
      removeToast(id);
      timersRef.current.delete(id);
    }, TOAST_DURATION);
    timersRef.current.set(id, timer);
  }, [removeToast]);

  const handleDismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    removeToast(id);
  }, [removeToast]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach(timer => clearTimeout(timer));
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast Container */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none" style={{ maxWidth: '400px' }}>
        {toasts.map(toast => {
          const style = typeStyles[toast.type];
          return (
            <div
              key={toast.id}
              className={`
                pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl shadow-xl ${style.bg} ${style.border}
                transition-all duration-300 ease-out
                ${toast.exiting ? 'opacity-0 translate-x-8' : 'opacity-100 translate-x-0 animate-slide-in-right'}
              `}
              role="alert"
            >
              {style.icon}
              <p className="text-sm text-primary_1 font-medium flex-1 leading-snug">{toast.message}</p>
              <button
                onClick={() => handleDismiss(toast.id)}
                className="text-gray-400 hover:text-primary_1 transition-colors flex-shrink-0 mt-0.5"
                aria-label="Dismiss notification"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Inject keyframes for slide-in animation */}
      <style>{`
        @keyframes slideInRight {
          from {
            opacity: 0;
            transform: translateX(100%);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .animate-slide-in-right {
          animation: slideInRight 0.3s ease-out;
        }
      `}</style>
    </ToastContext.Provider>
  );
};
