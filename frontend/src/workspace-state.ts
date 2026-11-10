import type { DesktopWindowState } from './desktop';

export const widgetNames = { internet: 'Connexion Internet', traffic: 'Activité réseau', server: 'Serveur Linux', devices: 'Appareils observés', events: 'Événements récents', services: 'Services et conteneurs' };
export type WidgetId = keyof typeof widgetNames;
export type Widget = { id: WidgetId; size: 'small' | 'wide' | 'tall'; hidden: boolean };
export type Workspace = { theme: 'light' | 'dark' | null; widgets: Widget[]; windows: DesktopWindowState[]; motion: 'performance' | 'balanced' | 'ultra'; accent: 'blue' | 'cyan' | 'violet'; restore: boolean; history_hours: number; server: string };
export const initialWorkspace: Workspace = { theme: null, widgets: (Object.keys(widgetNames) as WidgetId[]).map(id => ({ id, size: ['traffic', 'devices'].includes(id) ? 'wide' : 'small', hidden: false })), windows: [], motion: 'balanced', accent: 'blue', restore: true, history_hours: 24, server: '' };

export function moveWidget(items: Widget[], from: WidgetId, to: WidgetId): Widget[] {
  const result = [...items], start = result.findIndex(w => w.id === from), end = result.findIndex(w => w.id === to);
  if (start < 0 || end < 0) return items;
  result.splice(end, 0, result.splice(start, 1)[0]);
  return result;
}

export function metric(value: unknown, unit = '') {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + unit : 'Non disponible';
}
