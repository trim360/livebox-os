import { createContext, useEffect, useRef, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { Maximize2, Minus, X } from 'lucide-react';
import { clampWindow, type DesktopWindowState } from './desktop';

export const WindowVisibility = createContext(true);

export default function DesktopWindow({ win, name, color, icon: Icon, focus, patch, close, status, children }: {
  win: DesktopWindowState; name: string; color: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  focus: () => void; patch: (value: Partial<DesktopWindowState>) => void; close: () => void;
  status: string; children: ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  const drag = useRef<{ dx: number; dy: number; x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const geometry = useRef(win);
  const leaving = useRef(false);
  geometry.current = win;
  const applyPatch = useRef(patch);
  applyPatch.current = patch;

  useEffect(() => {
    if (!win.minimized) section.current?.querySelector<HTMLElement>('.window-titlebar')?.focus({ preventScroll: true });
  }, [win.minimized]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const current = geometry.current;
      if (current.minimized || current.maximized || innerWidth <= 600) return;
      const { offsetWidth: width, offsetHeight: height } = entry.target as HTMLElement;
      if (!width || !height) return;
      if (Math.abs(width - current.width) < 1 && Math.abs(height - current.height) < 1) return;
      const next = clampWindow({ ...current, width, height }, innerWidth, innerHeight);
      applyPatch.current({ width: next.width, height: next.height, x: next.x, y: next.y });
    });
    if (section.current) observer.observe(section.current);
    return () => { observer.disconnect(); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, []);

  function move() {
    if (!drag.current) return;
    const current = geometry.current;
    const next = clampWindow({ ...current, x: drag.current.x - drag.current.dx, y: drag.current.y - drag.current.dy }, innerWidth, innerHeight);
    patch({ x: next.x, y: next.y });
  }

  async function leave(minimize: boolean) {
    if (leaving.current) return;
    leaving.current = true;
    const element = section.current;
    if (element && !matchMedia('(prefers-reduced-motion: reduce)').matches && !element.closest('.motion-performance, .motion-disabled')) {
      const rect = element.getBoundingClientRect();
      const animation = element.animate([{ opacity: 1, scale: '1', translate: '0 0' }, { opacity: 0, scale: minimize ? '.25' : '.96', translate: minimize ? `0 ${Math.max(0, innerHeight - rect.bottom)}px` : '0 8px' }], { duration: minimize ? 180 : 130, easing: 'ease-in' });
      await animation.finished.catch(() => {});
    }
    if (section.current) { if (minimize) patch({ minimized: true }); else close(); }
    leaving.current = false;
  }

  return <section ref={section} aria-label={name} className={`os-window ${win.maximized ? 'maximized' : ''}`}
    style={{ '--window-x': `${win.x}px`, '--window-y': `${win.y}px`, width: win.width, height: win.height, zIndex: win.z, display: win.minimized ? 'none' : undefined } as CSSProperties}
    onPointerDown={focus} onFocusCapture={focus}>
    <div className="window-titlebar" tabIndex={0} role="group" aria-label={`Déplacer la fenêtre ${name}`} title="Flèches : déplacer. Maj + flèches : redimensionner. Entrée : agrandir ou restaurer."
      onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button')) patch({ maximized: !win.maximized }); }}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') { e.preventDefault(); patch({ maximized: !win.maximized }); return; }
        const directions: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
        if (!directions[e.key] || win.maximized) return;
        e.preventDefault();
        const [dx, dy] = directions[e.key];
        const next = clampWindow({ ...win, ...(e.shiftKey ? { width: win.width + dx, height: win.height + dy } : { x: win.x + dx, y: win.y + dy }) }, innerWidth, innerHeight);
        patch({ x: next.x, y: next.y, width: next.width, height: next.height });
      }}
      onPointerDown={e => {
        if ((e.target as HTMLElement).closest('button') || win.maximized || innerWidth <= 600) return;
        drag.current = { dx: e.clientX - win.x, dy: e.clientY - win.y, x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (!drag.current) return;
        drag.current.x = e.clientX; drag.current.y = e.clientY;
        if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; move(); });
      }}
      onPointerUp={() => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; move(); drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}>
      <span className={`title-icon ${color}`}><Icon size={16} /></span><strong>{name}</strong>
      <div className="window-controls">
        <button aria-label={`Réduire ${name}`} onClick={() => void leave(true)}><Minus size={16} /></button>
        <button aria-label={`${win.maximized ? 'Restaurer' : 'Agrandir'} ${name}`} onClick={() => patch({ maximized: !win.maximized })}><Maximize2 size={13} /></button>
        <button className="close-window" aria-label={`Fermer ${name}`} onClick={() => void leave(false)}><X size={17} /></button>
      </div>
    </div>
    <div className="window-content"><WindowVisibility.Provider value={!win.minimized}>{children}</WindowVisibility.Provider></div>
    <div className="window-status"><span>{status}</span><span>Livebox OS</span></div>
  </section>;
}
