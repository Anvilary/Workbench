/**
 * Elegir una carpeta para abrir un proyecto nuevo.
 *
 * Hasta el hito 18 no habia forma de empezar en una carpeta que la app no
 * conociera: la barra lista lo que esta en el historial de la CLI mas el
 * directorio desde el que se lanzo el servidor. Una carpeta nueva no aparecia
 * en ninguna lista.
 *
 * **El cliente no compone rutas.** Cada clic manda un `picker.enter` con *un
 * nombre del listado que el servidor acaba de mandar*, o un `..`, o el indice
 * de una raiz. La ruta absoluta la lleva el servidor y solo viaja para
 * mostrarla. Ver `directory-picker.ts`.
 *
 * Es un dialogo modal y no un panel: se abre, se elige y se cierra. Un panel
 * mas peleando por el ancho es justo lo que la seccion 6 evita.
 *
 * Desde el hito 28 tiene un segundo uso: elegir la carpeta de la copia propia.
 * Ahi quien lo usa no recibe una ruta para mandar de vuelta —eso seria el
 * cliente nombrando una ruta—, sino el `pickerId`: manda `vault.setDir` con el
 * y el servidor lee la carpeta de su propio selector. Por eso `onChoose` corre
 * **antes** de cerrar, que es cuando el selector todavia existe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirectoryPickerListing, ServerMessage } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';

interface FolderPickerProps {
  connection: AgentConnection;
  /** El titulo del dialogo. */
  title: string;
  /** El texto del boton que elige la carpeta donde se esta parado. */
  confirmLabel: string;
  /** El titulo de ese boton, con la carpeta. */
  confirmTitle: (path: string) => string;
  /**
   * Eligio la carpeta donde esta parado el selector. `path` es para mostrar o
   * para abrir una pestana (que el servidor valida); `pickerId` es lo que se
   * manda cuando la carpeta la tiene que leer el servidor. Quien llama cierra.
   */
  onChoose: (pickerId: string, path: string) => void;
  onClose: () => void;
}

export function FolderPicker({
  connection,
  title,
  confirmLabel,
  confirmTitle,
  onChoose,
  onClose,
}: FolderPickerProps): JSX.Element {
  const [listing, setListing] = useState<DirectoryPickerListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const pickerId = useRef<string | null>(null);
  const createRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSearchQuery('');
  }, [listing?.path]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredEntries = useMemo(() => {
    if (!listing) return [];
    if (!normalizedQuery) return listing.entries;
    return listing.entries.filter((name) =>
      name.toLowerCase().includes(normalizedQuery),
    );
  }, [listing, normalizedQuery]);

  useEffect(() => {
    const open = () => {
      const id = crypto.randomUUID();
      pickerId.current = id;
      setListing(null);
      setProblem(null);
      connection.sendImmediate({ type: 'picker.open', pickerId: id });
    };
    const offMessage = connection.onMessage((message: ServerMessage) => {
      if (message.type === 'picker.listing' && message.listing.pickerId === pickerId.current) {
        setListing(message.listing);
        setProblem(null);
        setCreating(false);
        setDraftName('');
      } else if (message.type === 'error' && message.code === 'picker-failed' &&
                 message.requestId === pickerId.current) {
        setProblem(serverTextMessage(message.text));
      }
    });
    const offStatus = connection.onStatus((status) => {
      pickerId.current = null;
      setListing(null);
      if (status === 'open') open();
    });
    if (connection.getStatus() === 'open') open();
    return () => {
      offMessage();
      offStatus();
      const id = pickerId.current;
      pickerId.current = null;
      if (id !== null) connection.sendImmediate({ type: 'picker.close', pickerId: id });
    };
  }, [connection]);

  // Esc cierra, como cualquier dialogo. En captura, para llegar antes que los
  // atajos de la aplicacion.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    if (creating) createRef.current?.focus();
  }, [creating]);

  const enter = useCallback(
    (name: string) => {
      const id = pickerId.current;
      if (id === null) return;
      connection.sendImmediate({ type: 'picker.enter', pickerId: id, name });
    },
    [connection],
  );

  const goToRoot = useCallback(
    (rootIndex: number) => {
      const id = pickerId.current;
      if (id === null) return;
      connection.sendImmediate({ type: 'picker.root', pickerId: id, rootIndex });
    },
    [connection],
  );

  const createFolder = useCallback(() => {
    const id = pickerId.current;
    const name = draftName.trim();
    if (id === null || name.length === 0) return;
    connection.sendImmediate({ type: 'picker.create', pickerId: id, name });
  }, [connection, draftName]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal picker-modal"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-button" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </header>

        {problem !== null && <p className="picker-problem" role="alert">{problem}</p>}
        {listing === null ? (
          problem === null ? <p className="panel-note">{t('picker.loading')}</p> : null
        ) : (
          <>
            <div className="picker-roots">
              {listing.roots.map((root, index) => (
                <button
                  key={root}
                  className="picker-root"
                  onClick={() => goToRoot(index)}
                  title={t('picker.goTo', { root })}
                >
                  {root}
                </button>
              ))}
            </div>

            {/* La ruta se muestra, no se escribe: la lleva el servidor. */}
            <p className="picker-path" title={listing.path}>
              {listing.path}
            </p>

            <div className="picker-search-bar">
              <input
                ref={searchInputRef}
                type="text"
                className="picker-search-input"
                placeholder={t('picker.searchPlaceholder')}
                aria-label={t('picker.searchPlaceholder')}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    if (searchQuery.length > 0) {
                      event.preventDefault();
                      event.stopPropagation();
                      setSearchQuery('');
                      return;
                    }
                  }
                  event.stopPropagation();
                }}
                spellCheck={false}
              />
              {searchQuery.length > 0 && (
                <button
                  type="button"
                  className="picker-search-clear"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  title={t('picker.clearSearch')}
                  aria-label={t('picker.clearSearch')}
                >
                  ×
                </button>
              )}
            </div>

            {normalizedQuery.length > 0 && (
              <p className="picker-search-status" role="status" aria-live="polite">
                {t('picker.searchResults', {
                  count: filteredEntries.length,
                  total: listing.entries.length,
                })}
              </p>
            )}

            <div className="picker-list">
              {listing.canGoUp && !normalizedQuery && (
                <button className="picker-entry picker-up" onClick={() => enter('..')}>
                  ‹ {t('picker.up')}
                </button>
              )}

              {listing.entries.length === 0 && !listing.canGoUp && (
                <p className="panel-note">{t('picker.empty')}</p>
              )}

              {listing.entries.length > 0 && filteredEntries.length === 0 && (
                <p className="panel-note">{t('picker.noSearchResults')}</p>
              )}

              {filteredEntries.map((name) => (
                <button key={name} className="picker-entry" onClick={() => enter(name)}>
                  {name}
                </button>
              ))}

              {listing.truncated && <p className="panel-note">{t('picker.truncated')}</p>}
            </div>


            <footer className="picker-footer">
              {creating ? (
                <div className="picker-create">
                  <input
                    ref={createRef}
                    className="picker-create-input"
                    value={draftName}
                    placeholder={t('picker.newFolderName')}
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') createFolder();
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setCreating(false);
                      }
                      // Que los atajos de la app no vean lo que se teclea aca.
                      event.stopPropagation();
                    }}
                    spellCheck={false}
                  />
                  <button className="primary-button primary-button-small" onClick={createFolder}>
                    {t('picker.create')}
                  </button>
                  <button className="link-button" onClick={() => setCreating(false)}>
                    {t('common.cancel')}
                  </button>
                </div>
              ) : (
                <button className="primary-button primary-button-small" onClick={() => setCreating(true)}>
                  {t('picker.createHere')}
                </button>
              )}

              <span className="composer-spacer" />

              <button
                className="picker-open"
                onClick={() => onChoose(listing.pickerId, listing.path)}
                title={confirmTitle(listing.path)}
              >
                {confirmLabel}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
