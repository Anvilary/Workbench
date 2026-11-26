/**
 * Tema claro y oscuro.
 *
 * Tres estados y un solo boton que los cicla: **sistema → claro → oscuro**.
 * "Sistema" es el valor por defecto y sigue a `prefers-color-scheme` en vivo,
 * asi que quien tenga el sistema en automatico ve la app cambiar sola al
 * anochecer sin haber tocado nada.
 *
 * La preferencia no va al servidor: es de esta pantalla, no del espacio de
 * trabajo. Dos ventanas pueden tener temas distintos sin pelearse. Se guarda
 * por `window-prefs.ts`, como las demas, y asi sobrevive a que la app arranque
 * en otro puerto.
 */

import { useCallback, useEffect, useState } from 'react';
import { t, type MessageKey } from '../../i18n/index.js';
import { writeStored } from '../lib/window-prefs.js';

export type ThemePreference = 'dark';
export type ResolvedTheme = 'dark';

const STORAGE_KEY = 'workbench.theme';

const THEME_KEYS: Readonly<Record<ThemePreference, MessageKey>> = {
  dark: 'theme.dark',
};

/** El titulo del boton: que tema hay puesto (§6.23). */
export function themeTitle(preference: ThemePreference = 'dark'): string {
  return t('theme.title', { theme: t(THEME_KEYS[preference] ?? 'theme.dark') });
}

export const THEME_ICON: Readonly<Record<ThemePreference, string>> = {
  dark: '☾',
};

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  /** Pasa al siguiente estado del ciclo (no-op: Workbench is strictly dark theme). */
  cycle: () => void;
}

export function useTheme(): ThemeState {
  const [preference] = useState<ThemePreference>('dark');
  const resolved: ResolvedTheme = 'dark';

  // Force dark theme attributes on <html> and overwrite any stale light preference.
  useEffect(() => {
    writeStored(STORAGE_KEY, 'dark');
    document.documentElement.dataset['theme'] = 'dark';
    document.documentElement.style.colorScheme = 'dark';
  }, []);

  const cycle = useCallback(() => {
    // Light theme removed; cockpit remains permanently dark
  }, []);

  return { preference, resolved, cycle };
}
