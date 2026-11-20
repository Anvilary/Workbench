import { createRoot } from 'react-dom/client';
import { initLocale } from './i18n/useLocale.js';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Falta el contenedor #root.');
const root = createRoot(container);

declare global {
  interface Window { mawRestoredBrowserTabs?: unknown[]; }
}

// El idioma se carga antes de pintar nada (§6.23): una primera pantalla en
// inglés que salta al español es peor que unos milisegundos de espera. Sin
// `await` de nivel superior, que el destino de compilación de Vite no admite.
//
// A proposito sin StrictMode: en desarrollo duplica los efectos, y cada montaje
// del terminal abre un proceso de la CLI. Un doble arranque por cada recarga no
// vale lo que aporta.
//
// La interfaz MAW no carga el Workbench clasico: ese codigo (y sus hooks, que escuchan el socket) llega en un
// fragmento aparte solo con `?view=workbench`.
async function start(): Promise<void> {
  const storage = await window.mawChatGpt?.command({ type: 'restore-shell-storage' }).catch(() => null) as {
    local?: [string, string][]; session?: [string, string][]; browserTabs?: unknown[];
  } | null | undefined;
  for (const [key, value] of storage?.local ?? []) localStorage.setItem(key, value);
  for (const [key, value] of storage?.session ?? []) sessionStorage.setItem(key, value);
  window.mawRestoredBrowserTabs = storage?.browserTabs ?? [];
  // Draft stores initialize during module evaluation, after storage restoration.
  const { ClassicRoot, WorkbenchRoot, isClassicView } = await import('./app/WorkbenchRoot.js');
  await initLocale();
  root.render(isClassicView(window.location.search) ? <ClassicRoot /> : <WorkbenchRoot />);
}
void start();
