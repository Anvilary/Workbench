/**
 * Una terminal enganchada a una pty del servidor.
 *
 * REGLA DURA: aca no se registra ni un solo manejador de teclado propio.
 * Todo lo que teclea el usuario sale por `onData` de xterm y va al pty sin
 * tocar. Es lo unico que garantiza que Esc, Esc Esc, Ctrl+C, Ctrl+R, Ctrl+O,
 * Shift+Tab, las flechas y Alt+V lleguen intactos a la CLI. Los atajos propios
 * de la app viven fuera de este componente. El dedo si tiene manejo propio
 * (§6.25): se convierte en la rueda del mouse, y lo demas lo decide xterm.
 *
 * Una excepcion, y solo en las consolas del pie: Ctrl+V pega (§5.2,
 * `pasteOnCtrlV`). La terminal del agente no la tiene nunca.
 *
 * Este componente NO es duenio del proceso: se engancha a una terminal que ya
 * existe en el servidor y se desengancha al desmontarse. Si el socket se cae y
 * vuelve, se reengancha y repinta con el replay.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal, type IMarker } from '@xterm/xterm';
import { TerminalOutput } from './terminal-output.js';
import type { TerminalId } from '@agent-workbench/shared';
import { writeClipboard, readClipboard } from './agency/clipboard.js';
import type { AgentConnection } from './connection.js';
import { isConsolePasteKey } from './console-paste.js';
import { t } from './i18n/index.js';
import {
  KEYBOARD_GESTURE_EVENTS,
  documentHasWindowFocus,
  shouldForwardTerminalData,
  shouldForwardWheelInput,
} from './terminal-input-gate.js';
import { isDrag, momentumStep, releaseVelocity, wholePixels, type TouchSample } from './touch-scroll.js';
import { useTerminalHistory } from './useTerminalHistory.js';

/** Capacidad del buffer de scrollback activo de xterm (lineas). */
export const ACTIVE_TERMINAL_SCROLLBACK = 42_000;

/** Espera a que el contenedor deje de cambiar de tamano antes de avisar al pty. */
const RESIZE_DEBOUNCE_MS = 60;

/**
 * Renderer del terminal.
 *
 * El default es canvas y no webgl, contra lo que sugiere el brief. Motivo
 * medido en Windows 11 + Chrome, la plataforma principal: con `WebglAddon` el
 * terminal queda en blanco aunque los datos lleguen, y el renderer del
 * navegador deja de responder. Se probo tambien cargando el addon despues del
 * primer fit, por si el problema era una textura de tamano cero: se cuelga
 * igual.
 *
 * Un renderer acelerado que congela la pestana es peor que uno mas lento, asi
 * que WebGL queda opt-in con ?renderer=webgl.
 */
function preferredRenderer(): 'webgl' | 'canvas' {
  return new URLSearchParams(window.location.search).get('renderer') === 'webgl'
    ? 'webgl'
    : 'canvas';
}

/**
 * Tema del terminal.
 *
 * Va aparte de la hoja de estilos porque xterm pinta sobre un canvas y no lee
 * variables CSS: hay que darle los colores en un objeto. Los valores siguen a
 * los de `styles.css` a mano; si se cambian alla, se cambian aca.
 *
 * Solo se fijan el fondo, el texto, el cursor y la seleccion. La paleta de 16
 * colores ANSI se deja en la que trae xterm: la CLI la usa para su propia
 * salida y redefinirla seria decidir por ella como se ve.
 *
 * Desde la 0.5.0 la terminal es oscura aunque la app este en claro, salvo que
 * se pida seguir el tema (`useTerminalTheme.ts`). En claro, en vez de tocar la
 * paleta, sube el contraste minimo: xterm oscurece la letra que no se lee sobre
 * el fondo —el amarillo de PowerShell, el gris tenue de una CLI— y deja como
 * esta la que ya se leia.
 */
const TERMINAL_THEMES = {
  dark: {
    background: '#0e0e10',
    foreground: '#ededea',
    cursor: '#d97442',
    selectionBackground: 'rgba(217, 116, 66, 0.28)',
  },
  light: {
    background: '#f8f8fa',
    foreground: '#141417',
    cursor: '#b8582a',
    selectionBackground: 'rgba(184, 88, 42, 0.2)',
  },
} as const;

/** El contraste minimo de cada tema (`minimumContrastRatio` de xterm; 1 es "no tocar"). */
const MINIMUM_CONTRAST = { dark: 1, light: 4.5 } as const;

interface TerminalViewProps {
  terminalId: TerminalId;
  connection: AgentConnection;
  /** Solo la pestana activa se ve; las demas quedan montadas pero ocultas. */
  active: boolean;
  theme: 'light' | 'dark';
  /**
   * Si al activarse se lleva el foco del teclado. La consola del panel derecho
   * dice que no: esta siempre activa, y con el default se robaria el foco de la
   * pestana del agente en cada recarga de la pagina.
   */
  autoFocus?: boolean;
  /**
   * Ctrl+V lo pega el navegador en vez de llegar a la pty como `^V` (§5.2).
   * Solo las consolas del pie, y solo con el navegador en Windows: en la terminal
   * del agente la tecla le llega a la CLI tal cual (§5).
   */
  pasteOnCtrlV?: boolean;
  /**
   * Atajos de seleccion y copia para la terminal nativa de Agency (Ctrl+A para
   * seleccionar todo, Ctrl+C para copiar si hay seleccion o interrumpir si no,
   * Ctrl+Shift+C para copia convencional).
   */
  enableAgencyShortcuts?: boolean;
  /**
   * Callback invocado cuando la instancia de xterm esta lista o se desmonta.
   */
  onTerminalInstance?: (terminal: Terminal | null) => void;
  /**
   * Notifica fallos al escribir en el portapapeles del sistema.
   */
  onClipboardError?: (error: Error) => void;
  /**
   * Notifica éxito al escribir en el portapapeles del sistema.
   */
  onClipboardSuccess?: (message?: string) => void;
  /**
   * Indica si la sesión proviene de un cliente remoto web.
   */
  isRemoteClient?: boolean;
  /**
   * Callback invocado cuando el usuario sube al tope del scrollback de xterm.
   */
  onScrolledToTop?: () => void;
  /**
   * Manejadores para respuestas de historial paginado del servidor.
   */
  historyHandlers?: RefObject<TerminalHistoryHandlers | null> | MutableRefObject<TerminalHistoryHandlers | null> | TerminalHistoryHandlers;
  /**
   * Habilita el viewport de historial persistente integrado (Lane F).
   */
  enablePersistentHistory?: boolean;
  /**
   * Callback invocado al presionar el atajo de buscar en terminal (Ctrl+Shift+F).
   */
  onOpenSearch?: () => void;
  /**
   * Provee acceso al SearchAddon de la terminal para controladores externos.
   */
  onSearchAddon?: (addon: SearchAddon | null) => void;
}

export interface TerminalHistoryHandlers {
  onData: (message: any) => void;
  onError: (message: any) => void;
}

function cleanAnsiForDisplay(text: string): string {
  const stripped = text
    .replace(/\x1b\[[0-9;?<=>]*[a-zA-Z~]/g, '')
    .replace(/\x1b\].*?(\x07|\x1b\\)/g, '');
  if (stripped.includes('\r')) {
    const parts = stripped.split('\r');
    return parts[parts.length - 1] ?? '';
  }
  return stripped;
}

function containsTuiMarkers(lines: readonly string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      line.includes('\x1b[?1049h') ||
      line.includes('\x1b[?1049l') ||
      line.includes('\x1b[2J') ||
      line.includes('\x1b[3J') ||
      line.includes('\x1b[H') ||
      /\x1b\[[0-9]+;[0-9]+H/.test(line)
    ) {
      return true;
    }
  }
  return false;
}

export function TerminalView({
  terminalId,
  connection,
  active,
  theme,
  autoFocus = true,
  pasteOnCtrlV = false,
  enableAgencyShortcuts = true,
  onTerminalInstance,
  onClipboardError,
  onClipboardSuccess,
  isRemoteClient = false,
  onScrolledToTop,
  historyHandlers: historyHandlersProp,
  enablePersistentHistory = true,
  onOpenSearch,
  onSearchAddon,
}: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const restoringReplay = useRef(false);
  const onTerminalInstanceRef = useRef(onTerminalInstance);
  onTerminalInstanceRef.current = onTerminalInstance;
  const onClipboardErrorRef = useRef(onClipboardError);
  onClipboardErrorRef.current = onClipboardError;
  const onClipboardSuccessRef = useRef(onClipboardSuccess);
  onClipboardSuccessRef.current = onClipboardSuccess;
  const isRemoteClientRef = useRef(isRemoteClient);
  isRemoteClientRef.current = isRemoteClient;
  const onScrolledToTopRef = useRef(onScrolledToTop);
  onScrolledToTopRef.current = onScrolledToTop;
  const onOpenSearchRef = useRef(onOpenSearch);
  onOpenSearchRef.current = onOpenSearch;
  const onSearchAddonRef = useRef(onSearchAddon);
  onSearchAddonRef.current = onSearchAddon;

  const [historyOpen, setHistoryOpen] = useState(false);
  const [showHistoryPrompt, setShowHistoryPrompt] = useState(false);
  const history = useTerminalHistory(terminalId, connection, active && enablePersistentHistory);
  const historyRef = useRef(history);
  historyRef.current = history;

  const defaultHistoryHandlersRef = useRef<TerminalHistoryHandlers | null>(null);
  const historyHandlers = (historyHandlersProp && 'current' in historyHandlersProp)
    ? historyHandlersProp
    : defaultHistoryHandlersRef;
  if (historyHandlersProp && !('current' in historyHandlersProp)) {
    defaultHistoryHandlersRef.current = historyHandlersProp;
  }
  // El tema entra por un ref para que cambiarlo no vuelva a correr el efecto de
  // montaje: recrear el terminal perderia la pantalla y reabriria el attach.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  // Same idea for `active`: the mount effect must read the current value without re-running.
  const activeRef = useRef(active);
  activeRef.current = active;

  // Manejo de la tecla Escape para cerrar el visor de historial y volver a la terminal activa
  useEffect(() => {
    if (!historyOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setHistoryOpen(false);
        terminalRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [historyOpen]);

  const allHistoryLines = useMemo(() => {
    const reversedPages = [...history.pages].reverse();
    const lines: string[] = [];
    for (const p of reversedPages) {
      for (const line of p.lines) {
        lines.push(cleanAnsiForDisplay(line));
      }
    }
    return lines;
  }, [history.pages]);

  const hasTuiMarkers = useMemo(() => {
    for (const p of history.pages) {
      if (containsTuiMarkers(p.lines)) return true;
    }
    return false;
  }, [history.pages]);

  const handleCopyHistory = useCallback(() => {
    const text = allHistoryLines.join('\n');
    if (text.length > 0) {
      navigator.clipboard.writeText(text).catch((err) => {
        onClipboardErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      });
    }
  }, [allHistoryLines]);

  const historyScrollRef = useRef<HTMLDivElement | null>(null);
  const prevScrollHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);
  const isAutoOpeningRef = useRef<boolean>(false);

  const handleOpenHistory = useCallback(() => {
    isAutoOpeningRef.current = true;
    setHistoryOpen(true);
    if (history.pages.length === 0) {
      history.loadOlder();
    }
  }, [history]);

  useLayoutEffect(() => {
    const el = historyScrollRef.current;
    if (!el || !historyOpen) return;

    if (isAutoOpeningRef.current) {
      el.scrollTop = el.scrollHeight;
      isAutoOpeningRef.current = false;
      prevScrollHeightRef.current = el.scrollHeight;
      prevScrollTopRef.current = el.scrollTop;
      return;
    }

    const prevHeight = prevScrollHeightRef.current;
    const currentHeight = el.scrollHeight;
    const diff = currentHeight - prevHeight;

    if (diff > 0 && prevScrollTopRef.current !== undefined) {
      el.scrollTop = prevScrollTopRef.current + diff;
    }

    prevScrollHeightRef.current = currentHeight;
    prevScrollTopRef.current = el.scrollTop;
  }, [allHistoryLines.length, historyOpen]);

  const handleHistoryScroll = useCallback(() => {
    const el = historyScrollRef.current;
    if (!el) return;
    prevScrollTopRef.current = el.scrollTop;
    prevScrollHeightRef.current = el.scrollHeight;

    if (el.scrollTop <= 10 && history.hasMore && !history.loading) {
      history.loadOlder();
    }
  }, [history]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "Consolas", "Menlo", "DejaVu Sans Mono", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: ACTIVE_TERMINAL_SCROLLBACK,
      allowProposedApi: true,
      theme: TERMINAL_THEMES[themeRef.current],
      minimumContrastRatio: MINIMUM_CONTRAST[themeRef.current],
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);
    (terminal as unknown as { __mawSearchAddon?: SearchAddon }).__mawSearchAddon = searchAddon;
    onSearchAddonRef.current?.(searchAddon);
    terminal.open(container);
    onTerminalInstanceRef.current?.(terminal);

    // WebGL is opt-in (?renderer=webgl): its addon (~100 KB) is fetched only then, never on the default path.
    // The terminal may be disposed while the chunk loads; `terminalDisposed` keeps a late addon off it.
    let webglAttempted = false;
    let terminalDisposed = false;
    const enableWebglRenderer = (): void => {
      if (webglAttempted || preferredRenderer() !== 'webgl') return;
      webglAttempted = true;
      void import('@xterm/addon-webgl').then((module) => {
        if (terminalDisposed) return;
        // The package is UMD/CommonJS: a dynamic import exposes it as `default` (bundler interop), not as a
        // named export. Accept both shapes.
        const WebglAddon = module.WebglAddon ?? (module as unknown as { default?: typeof module }).default?.WebglAddon;
        if (typeof WebglAddon !== 'function') throw new Error('WebGL addon export not found');
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        terminal.loadAddon(webgl);
      }).catch((error: unknown) => {
        console.info('[terminal] WebGL no disponible; se usa el renderer por defecto.', String(error));
      });
    };

    let lastSize = { cols: 0, rows: 0 };
    let resizeTimer: number | undefined;

    /**
     * true si el contenedor tiene caja.
     *
     * Desde que la terminal vive en la columna derecha esto **no** es una
     * comprobacion defensiva de arranque: con la solapa CLI detras de Cambios o
     * Archivos el contenedor mide 0x0 todo el tiempo que dure la visita. Un
     * `fit()` sobre una caja vacia deja el terminal en una o dos columnas, y
     * ese tamano se le reenvia al pty: la CLI se redibuja rota y no se recupera
     * sola. Mientras no haya caja no se mide ni se avisa nada, y el proceso
     * conserva el ultimo tamano bueno.
     */
    const hasBox = (): boolean => container.clientWidth > 0 && container.clientHeight > 0;

    const sendResize = (force: boolean): void => {
      const { cols, rows } = terminal;
      if (cols <= 0 || rows <= 0) return;
      if (!force && cols === lastSize.cols && rows === lastSize.rows) return;
      lastSize = { cols, rows };
      connection.send({ type: 'resize', terminalId, cols, rows });
    };

    /*
      Un cambio de tamano no te saca de donde estabas (§5.6). Medido en el
      emulador con la app de Android, 25-09-2026:

      - La vista que no se ve queda sin tamano, y el navegador pone en 0 la
        barra de scroll de xterm sin que xterm se entere: al volver, la barra
        decia "arriba" y el texto "abajo", y el primer toque saltaba al
        principio del historial. En la PC pasaba igual al volver a la solapa
        CLI desde Cambios o Archivos.
      - Al cerrarse el teclado del telefono la terminal crece (17 a 33 filas), y
        xterm quedaba 16 lineas arriba del final, sin seguir la salida nueva:
        habia que escribir algo para que bajara.

      Mientras la caja cambia no se anota nada, porque la posicion que xterm
      cree tener en ese rato es la rota. Despues del fit se vuelve: al final si
      estaba al final, o a la misma linea si uno habia subido a leer.
    */
    let seen = { atBottom: true, line: 0 };
    let resizing = false;
    const rememberPosition = (): void => {
      if (resizing || !hasBox()) return;
      const buffer = terminal.buffer.active;
      seen = { atBottom: buffer.viewportY >= buffer.baseY, line: buffer.viewportY };
    };
    const restorePosition = (): void => {
      const buffer = terminal.buffer.active;
      if (buffer.baseY === 0) return;
      const target = seen.atBottom ? buffer.baseY : Math.min(seen.line, buffer.baseY);
      // Ida y vuelta de una linea: moverse obliga a xterm a volver a poner su
      // barra donde va, que es lo que el navegador le desacomodo.
      terminal.scrollToLine(target > 0 ? target - 1 : target + 1);
      terminal.scrollToLine(target);
    };
    // Lo que desplaza el usuario no pasa por `onScroll`, pero se pinta.
    const renderSubscription = terminal.onRender(rememberPosition);
    const scrollSubscription = terminal.onScroll(rememberPosition);
    let boxShown = hasBox();

    const fitAndReport = (): void => {
      if (!hasBox() || restoringReplay.current) return;
      try {
        fitAddon.fit();
      } catch {
        // El contenedor todavia no tiene tamano. El siguiente evento reintenta.
        return;
      }
      if (resizing) {
        restorePosition();
        resizing = false;
      }
      if (terminal.cols > 0 && terminal.rows > 0) enableWebglRenderer();
      sendResize(false);
    };

    const scheduleFit = (): void => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(fitAndReport, RESIZE_DEBOUNCE_MS);
    };

    const resizeObserver = new ResizeObserver(() => {
      const shown = hasBox();
      resizing = true;
      // Al reaparecer, tambien en el acto: que no se pinte el principio del historial hasta el fit.
      if (shown && !boxShown) restorePosition();
      boxShown = shown;
      scheduleFit();
    });
    resizeObserver.observe(container);
    window.addEventListener('resize', scheduleFit);

    /*
      Deslizar el dedo (§6.25): lo mismo que la rueda del mouse en la PC. El
      manejo propio de xterm movia el historial 1 a 1 y se paraba en seco al
      soltar (con miles de lineas, leer para atras era casi no moverse), y con
      una CLI a pantalla completa, o que pidio el mouse, no hacia nada. Cada
      movimiento va como una rueda a la terminal y xterm decide que es: su
      historial, flechas o la rueda de la CLI. Al soltar rapido sigue un rato,
      frenandose (`touch-scroll.ts`). Un toque sin arrastrar no se toca: sigue
      siendo el clic que enfoca la terminal y abre el teclado.

      Los oyentes van en captura sobre el contenedor: xterm escucha el dedo en
      su elemento, adentro, y no tiene que enterarse, o desplazaria dos veces.
    */
    let drag: {
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      moving: boolean;
      samples: TouchSample[];
    } | null = null;
    let momentumFrame = 0;
    let pendingPixels = 0;

    const scrollByPixels = (amount: number, clientX: number, clientY: number): void => {
      const target = terminal.element;
      if (target === undefined) return;
      const whole = wholePixels(pendingPixels + amount);
      pendingPixels = whole.rest;
      if (whole.pixels === 0) return;
      target.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: whole.pixels,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    const stopMomentum = (): void => {
      window.cancelAnimationFrame(momentumFrame);
      momentumFrame = 0;
    };

    const startMomentum = (velocity: number, clientX: number, clientY: number): void => {
      let current = velocity;
      let last = performance.now();
      const frame = (now: number): void => {
        if (!hasBox()) {
          momentumFrame = 0;
          return;
        }
        const step = momentumStep(current, now - last);
        last = now;
        scrollByPixels(step.delta, clientX, clientY);
        current = step.velocity;
        momentumFrame = current === 0 ? 0 : window.requestAnimationFrame(frame);
      };
      momentumFrame = window.requestAnimationFrame(frame);
    };

    const touchById = (list: TouchList, id: number): Touch | null => {
      for (let index = 0; index < list.length; index++) {
        const touch = list.item(index);
        if (touch !== null && touch.identifier === id) return touch;
      }
      return null;
    };

    const onTouchStart = (event: TouchEvent): void => {
      stopMomentum();
      pendingPixels = 0;
      const touch = event.touches.length === 1 ? event.touches.item(0) : null;
      drag =
        touch === null
          ? null
          : {
              id: touch.identifier,
              startX: touch.clientX,
              startY: touch.clientY,
              lastX: touch.clientX,
              lastY: touch.clientY,
              moving: false,
              samples: [{ t: event.timeStamp, y: touch.clientY }],
            };
    };

    const onTouchMove = (event: TouchEvent): void => {
      event.stopPropagation();
      if (drag === null) return;
      const touch = touchById(event.touches, drag.id);
      if (touch === null) return;
      if (!drag.moving) {
        if (!isDrag(touch.clientX - drag.startX, touch.clientY - drag.startY)) return;
        drag.moving = true;
      }
      if (event.cancelable) event.preventDefault();
      const delta = drag.lastY - touch.clientY;
      drag.lastX = touch.clientX;
      drag.lastY = touch.clientY;
      drag.samples.push({ t: event.timeStamp, y: touch.clientY });
      if (drag.samples.length > 32) drag.samples.shift();
      scrollByPixels(delta, touch.clientX, touch.clientY);
    };

    const onTouchEnd = (event: TouchEvent): void => {
      if (drag === null || touchById(event.changedTouches, drag.id) === null) return;
      const ended = drag;
      drag = null;
      if (!ended.moving) return;
      const velocity = releaseVelocity(ended.samples, event.timeStamp);
      if (velocity !== 0) startMomentum(velocity, ended.lastX, ended.lastY);
    };

    const onTouchCancel = (): void => {
      drag = null;
    };

    container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    container.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    container.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });

    /*
      Dos pantallas mirando la misma pestana (hito 37): esta ventana y la del
      otro equipo, de otro tamano. La pty tiene **un** tamano, y el servidor se
      queda con el ultimo que le mandaron; una ventana solo lo manda cuando su
      caja cambia, asi que al volver a esta despues de usar la otra, la CLI
      seguia dibujada para aquella hasta que alguien movia un divisor.

      Al recuperar el foco, o al volver a estar a la vista, la terminal que se
      ve reclama su tamano aunque para ella no haya cambiado (`force`). La que
      nadie mira queda desacomodada, y se acomoda sola cuando le toque. Con una
      sola ventana es un `resize` con el mismo tamano, como el que ya manda
      activar una pestana.
    */
    const reclaimSize = (): void => {
      if (restoringReplay.current || document.visibilityState !== 'visible' || !hasBox()) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      sendResize(true);
    };
    window.addEventListener('focus', reclaimSize);
    document.addEventListener('visibilitychange', reclaimSize);

    // Clicking on container letterbox outside terminal text rows clears active selection
    const onContainerPointerDown = (event: PointerEvent): void => {
      if (event.target === container && terminal.hasSelection()) {
        terminal.clearSelection();
      }
    };
    container.addEventListener('pointerdown', onContainerPointerDown);

    /*
      Seguimiento semántico de comandos de shell mediante OSC 133.
      Permite identificar con precisión el inicio de la última salida en buffers normales.
    */
    let lastCommandStartMarker: IMarker | null = null;
    let lastPromptStartMarker: IMarker | null = null;

    const oscDisposable = terminal.parser.registerOscHandler(133, (data) => {
      if (data.startsWith('C')) {
        lastCommandStartMarker?.dispose();
        lastCommandStartMarker = terminal.registerMarker(0);
        (terminal as unknown as { __mawLastCommandMarker?: IMarker | null }).__mawLastCommandMarker = lastCommandStartMarker;
      } else if (data.startsWith('A')) {
        lastPromptStartMarker?.dispose();
        lastPromptStartMarker = terminal.registerMarker(0);
        (terminal as unknown as { __mawLastPromptMarker?: IMarker | null }).__mawLastPromptMarker = lastPromptStartMarker;
      }
      return true;
    });

    // Teclas del usuario -> pty. Input isolation: keyboard-origin data (keys, IME, paste on the
    // xterm textarea) is forwarded only while this terminal owns the keyboard; protocol replies
    // and programmatic input are not keyboard input and pass untouched (see terminal-input-gate.ts).
    let lastKeyboardGestureAt: number | null = null;
    const markKeyboardGesture = (): void => {
      lastKeyboardGestureAt = performance.now();
    };
    const gestureTarget = terminal.textarea ?? null;
    if (gestureTarget !== null) {
      for (const name of KEYBOARD_GESTURE_EVENTS) gestureTarget.addEventListener(name, markKeyboardGesture, true);
    }

    /*
      Atajos de teclado unificados:
      - Ctrl+Shift+A selecciona todo el buffer accesible (5.000 lineas).
      - Ctrl+A sin shift no se intercepta y llega intacto a la CLI/shell (inicio de linea, tmux, etc.).
      - Ctrl+Shift+C copia la seleccion como atajo convencional de terminal.
      - Ctrl+C: en pantalla alterna (Codex, htop, etc.) viaja al PTY; en buffer normal copia y deselecciona.
      - Ctrl+Shift+V pega contenido del portapapeles hacia la PTY.
      - Ctrl+V en consolas con pasteOnCtrlV permite que el navegador pegue.
    */
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      const isCtrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      // Escape clears terminal selection if one is active, preventing accidental PTY escape
      if (key === 'escape' && !isCtrl && !event.shiftKey && !event.altKey) {
        if (terminal.hasSelection()) {
          terminal.clearSelection();
          return false;
        }
      }

      // Ctrl+Shift+A selects all accessible history in the active terminal buffer
      if (isCtrl && event.shiftKey && !event.altKey && key === 'a') {
        terminal.selectAll();
        return false;
      }

      if (enableAgencyShortcuts) {
        // Ctrl+Shift+F: search terminal output
        if (isCtrl && event.shiftKey && !event.altKey && key === 'f') {
          onOpenSearchRef.current?.();
          return false;
        }

        // Ctrl+Shift+C: conventional terminal copy
        if (isCtrl && event.shiftKey && !event.altKey && key === 'c') {
          if (terminal.hasSelection()) {
            const text = terminal.getSelection();
            if (text) {
              void writeClipboard(text, isRemoteClientRef.current).then((ok) => {
                if (ok) {
                  onClipboardSuccessRef.current?.(t('agency.ui.copied'));
                } else {
                  onClipboardErrorRef.current?.(new Error(t('agency.ui.clipboardUnavailable')));
                }
              });
            }
            terminal.clearSelection();
          } else {
            onClipboardErrorRef.current?.(new Error(t('agency.ui.nothingSelected')));
          }
          return false;
        }

        // Ctrl+C:
        // In alternate-screen applications (like raw Codex, nano, vi, less, htop),
        // pass Ctrl+C directly to the PTY so application interrupts/cancellations function reliably.
        // In normal-screen shells, copy if selection exists and clear the selection,
        // ensuring subsequent Ctrl+C presses reach the PTY for command interruption.
        if (isCtrl && !event.shiftKey && !event.altKey && key === 'c') {
          if (terminal.buffer.active.type === 'alternate') {
            return true;
          }
          if (terminal.hasSelection()) {
            const text = terminal.getSelection();
            if (text) {
              void writeClipboard(text, isRemoteClientRef.current).then((ok) => {
                if (ok) {
                  onClipboardSuccessRef.current?.(t('agency.ui.copied'));
                } else {
                  onClipboardErrorRef.current?.(new Error(t('agency.ui.clipboardUnavailable')));
                }
              });
            }
            terminal.clearSelection();
            return false;
          }
          return true;
        }

        // Ctrl+Shift+V: conventional terminal paste
        if (isCtrl && event.shiftKey && !event.altKey && key === 'v') {
          event.preventDefault();
          if (activeRef.current) {
            if (gestureTarget !== null && document.activeElement !== gestureTarget) {
              terminal.focus();
            }
            void readClipboard(isRemoteClientRef.current)
              .then((text) => {
                if (text && activeRef.current && terminalRef.current) {
                  markKeyboardGesture();
                  terminalRef.current.paste(text);
                }
              })
              .catch((err) => {
                onClipboardErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
              });
          }
          return false;
        }
      }

      if (pasteOnCtrlV && isConsolePasteKey(event)) {
        return false;
      }

      return true;
    });

    // Custom wheel handler for alternate screen fallback:
    // When Shift+Wheel is used in an alternate-screen application (like raw Codex, less, etc.),
    // send PageUp / PageDown keys to the PTY so conversation/pager history scrolls.
    terminal.attachCustomWheelEventHandler((event) => {
      if (event.shiftKey && terminal.buffer.active.type === 'alternate' && shouldForwardWheelInput(activeRef.current)) {
        const key = event.deltaY < 0 ? '\x1b[5~' : '\x1b[6~';
        connection.send({ type: 'input', terminalId, data: key });
        event.preventDefault();
        return false;
      }
      return true;
    });

    const dataSubscription = terminal.onData((data) => {
      const forward = shouldForwardTerminalData({
        lastGestureAt: lastKeyboardGestureAt,
        now: performance.now(),
        ownership: {
          active: activeRef.current,
          textareaFocused: gestureTarget !== null && document.activeElement === gestureTarget,
          documentFocused: documentHasWindowFocus(document),
        },
      });
      if (!forward) return;
      connection.send({ type: 'input', terminalId, data });
    });

    const checkScrollbackPrompt = (): void => {
      if (restoringReplay.current) {
        setShowHistoryPrompt(false);
        return;
      }
      const inAlternateScreen = terminal.buffer.active.type === 'alternate';
      if (inAlternateScreen) {
        setShowHistoryPrompt(false);
        return;
      }
      if (terminal.buffer.active.viewportY === 0 && terminal.buffer.active.baseY > 0) {
        onScrolledToTopRef.current?.();
        setShowHistoryPrompt(true);
      } else {
        setShowHistoryPrompt(false);
      }
    };

    const scrollSub = terminal.onScroll(checkScrollbackPrompt);
    const bufferSub = terminal.buffer.onBufferChange(checkScrollbackPrompt);

    const output = new TerminalOutput(terminal, (restoring) => {
      restoringReplay.current = restoring;
      if (!restoring) fitAndReport();
    });
    const offMessage = connection.onMessage((message) => {
      if (!('terminalId' in message) || message.terminalId !== terminalId) return;
      switch (message.type) {
        case 'terminal.output':
          output.output(message.data, message.offset);
          break;
        case 'terminal.replay':
          output.replay(message);
          break;
        case 'terminal.exit':
          output.output(`\r\n\x1b[90m-- ${t('terminal.exited', { code: message.exitCode })} --\x1b[0m\r\n`);
          break;
        case 'terminal.history.data':
          if (message.terminalId === terminalId) {
            historyRef.current._handleHistoryData(message);
            historyHandlers.current?.onData(message);
          }
          break;
        case 'terminal.history.error':
          if (message.terminalId === terminalId) {
            historyRef.current._handleHistoryError(message);
            historyHandlers.current?.onError(message);
          }
          break;
      }
    });

    /** Pide el buffer y sincroniza el tamano. Corre al montar y al reconectar. */
    const attach = (): void => {
      if (hasBox() && !restoringReplay.current) {
        try {
          fitAddon.fit();
        } catch {
          // Sin tamano todavia; el ResizeObserver reintenta enseguida.
        }
      }
      const cols = terminal.cols > 0 ? terminal.cols : 80;
      const rows = terminal.rows > 0 ? terminal.rows : 24;
      lastSize = { cols, rows };
      connection.send({
        type: 'terminal.attach',
        terminalId,
        cols,
        rows,
        ...(output.offset !== undefined ? { sinceOffset: output.offset } : {}),
      });
    };

    attach();
    const offReopen = connection.onReopen(attach);

    return () => {
      window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', scheduleFit);
      window.removeEventListener('focus', reclaimSize);
      document.removeEventListener('visibilitychange', reclaimSize);
      resizeObserver.disconnect();
      stopMomentum();
      container.removeEventListener('touchstart', onTouchStart, { capture: true });
      container.removeEventListener('touchmove', onTouchMove, { capture: true });
      container.removeEventListener('touchend', onTouchEnd, { capture: true });
      container.removeEventListener('touchcancel', onTouchCancel, { capture: true });
      container.removeEventListener('pointerdown', onContainerPointerDown);
      renderSubscription.dispose();
      scrollSubscription.dispose();
      scrollSub.dispose();
      bufferSub.dispose();
      dataSubscription.dispose();
      if (gestureTarget !== null) {
        for (const name of KEYBOARD_GESTURE_EVENTS) gestureTarget.removeEventListener(name, markKeyboardGesture, true);
      }
      oscDisposable.dispose();
      lastCommandStartMarker?.dispose();
      lastPromptStartMarker?.dispose();
      offMessage();
      offReopen();
      // Desenganchar no mata el proceso: la pty sigue viva en el servidor.
      connection.send({ type: 'terminal.detach', terminalId });
      terminalDisposed = true;
      output.dispose();
      restoringReplay.current = false;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      onTerminalInstanceRef.current?.(null);
      onSearchAddonRef.current?.(null);
      searchAddon.dispose();
    };
    // `pasteOnCtrlV` y `enableAgencyShortcuts` no cambian en la vida de una vista.
  }, [terminalId, connection, pasteOnCtrlV, enableAgencyShortcuts]);

  // Cambiar de tema repinta el terminal en el lugar, sin recrearlo.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null) return;
    terminal.options.theme = TERMINAL_THEMES[theme];
    terminal.options.minimumContrastRatio = MINIMUM_CONTRAST[theme];
  }, [theme]);

  // Al volver a una pestana hay que remedir: mientras estuvo oculta el
  // contenedor pudo cambiar de tamano sin que xterm se enterara.
  useEffect(() => {
    if (!active) return;
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    if (terminal === null || fitAddon === null) return;

    const timer = window.setTimeout(() => {
      // Mismo motivo que `hasBox()`: activar una pestana cuya solapa no esta
      // delante no puede terminar en un resize contra una caja vacia.
      const container = containerRef.current;
      if (restoringReplay.current || container === null || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (autoFocus) terminal.focus();
      if (terminal.cols > 0 && terminal.rows > 0) {
        connection.send({
          type: 'resize',
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [active, autoFocus, terminalId, connection]);

  return (
    <div className={`terminal-surface${active ? '' : ' terminal-surface-hidden'}`}>
      {historyOpen && (
        <div
          className="terminal-history-viewport"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            maxHeight: '65%',
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: theme === 'dark' ? '#16161a' : '#f0f0f4',
            borderBottom: `1px solid ${theme === 'dark' ? '#2f2f36' : '#d4d4dc'}`,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            fontFamily: '"JetBrains Mono", "Cascadia Mono", "Consolas", "Menlo", monospace',
            fontSize: '13px',
            color: theme === 'dark' ? '#ededea' : '#141417',
          }}
          role="region"
          aria-label="Terminal History Viewport"
        >
          <div
            className="terminal-history-toolbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 12px',
              backgroundColor: theme === 'dark' ? '#141417' : '#e6e6ed',
              borderBottom: `1px solid ${theme === 'dark' ? '#25252b' : '#d4d4dc'}`,
              fontSize: '12px',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <strong>Terminal History (Read-only)</strong>
              <span style={{ opacity: 0.7 }}>
                {allHistoryLines.length} lines loaded ({history.totalLines} on disk)
              </span>
              {history.prunedLines > 0 && (
                <span style={{ color: '#ec8a4a' }}>
                  ({history.prunedLines} pruned)
                </span>
              )}
              {history.incomplete && (
                <span role="status" className="terminal-history-loss" style={{ color: '#ec8a4a' }}>
                  History is incomplete{history.droppedBytes > 0 ? ` (${history.droppedBytes} bytes lost)` : ''}.
                </span>
              )}
              {history.error && (
                <span role="alert" style={{ color: '#b13318' }}>{history.error}</span>
              )}
              {hasTuiMarkers && (
                <span
                  title="Output contains cursor addressing or alternate screen sequences that may not render as linear text"
                  style={{ color: '#d97442', cursor: 'help' }}
                >
                  [TUI screen fidelity limited]
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button
                type="button"
                className="link-button"
                onClick={() => history.loadOlder()}
                disabled={history.loading || !history.hasMore}
                style={{ padding: '2px 8px', fontSize: '12px' }}
              >
                {history.loading ? 'Loading...' : (history.hasMore ? 'Load Older (1k lines)' : 'Start of History')}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={handleCopyHistory}
                disabled={allHistoryLines.length === 0}
                style={{ padding: '2px 8px', fontSize: '12px' }}
              >
                Copy History
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setHistoryOpen(false);
                  terminalRef.current?.focus();
                }}
                style={{ padding: '2px 8px', fontSize: '12px', fontWeight: 'bold' }}
              >
                Jump to Live (Esc)
              </button>
            </div>
          </div>
          <div
            ref={historyScrollRef}
            className="terminal-history-lines"
            onScroll={handleHistoryScroll}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '8px 12px',
              fontFamily: '"JetBrains Mono", "Cascadia Mono", "Consolas", "Menlo", "DejaVu Sans Mono", monospace',
              fontSize: '13px',
              lineHeight: '1.4',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              userSelect: 'text',
              maxHeight: '380px',
            }}
          >
            {allHistoryLines.length === 0 ? (
              <span style={{ opacity: 0.5 }}>No historical lines loaded. Click "Load Older" above.</span>
            ) : (
              allHistoryLines.join('\n')
            )}
          </div>
        </div>
      )}
      {!historyOpen && showHistoryPrompt && (
        <div
          className="terminal-history-prompt"
          style={{
            position: 'absolute',
            top: '8px',
            right: '8px',
            maxWidth: 'calc(100% - 16px)',
            maxHeight: 'calc(100% - 16px)',
            boxSizing: 'border-box',
            overflow: 'hidden',
            zIndex: 15,
            backgroundColor: theme === 'dark' ? '#16161a' : '#ffffff',
            border: `1px solid ${theme === 'dark' ? '#2f2f36' : '#d4d4dc'}`,
            borderTop: '2px solid #d97442',
            borderRadius: '6px',
            padding: '4px 8px',
            fontSize: '12px',
            lineHeight: '1.4',
            color: theme === 'dark' ? '#ededea' : '#141417',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '6px 8px',
            pointerEvents: 'auto',
          }}
        >
          <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>Top of live scrollback reached</span>
          <button
            type="button"
            className="link-button"
            onClick={handleOpenHistory}
            style={{
              padding: '2px 8px',
              fontSize: '12px',
              fontWeight: 'bold',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              color: '#d97442',
            }}
          >
            Open Persistent History
          </button>
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
