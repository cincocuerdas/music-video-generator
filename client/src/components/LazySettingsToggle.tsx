import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Settings2, X } from 'lucide-react';

const SettingsToggle = lazy(() =>
  import('./SettingsToggle').then((m) => ({ default: m.SettingsToggle })),
);

const fallbackClassName =
  'h-9 w-28 rounded-full border border-white/10 bg-white/5 dark:border-gray-700 dark:bg-gray-800/50';

export function LazySettingsToggle() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Toggle settings"
        aria-expanded={open}
        className="h-9 w-9 rounded-full border border-white/10 bg-white/5 dark:border-gray-700 dark:bg-gray-800/50 text-gray-400 hover:text-stitch-cyan transition-colors flex items-center justify-center"
      >
        {open ? <X size={16} /> : <Settings2 size={16} />}
      </button>
      {open ? (
        <div className="absolute right-0 mt-2 z-[60]">
          <Suspense fallback={<div className={fallbackClassName} />}>
            <SettingsToggle />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
