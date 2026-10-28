import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(root, 'packages/web/src/i18n/locales');
const languages = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'];

export function removeTranslations(keys) {
  for (const lang of languages) {
    const file = path.join(localesDir, `${lang}.json`);
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of keys) {
      delete current[key];
    }
    const sorted = Object.fromEntries(
      Object.entries(current).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
    fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  }
}
export function addTranslations(records) {
  for (const lang of languages) {
    const file = path.join(localesDir, `${lang}.json`);
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, translations] of Object.entries(records)) {
      if (translations[lang] !== undefined) {
        current[key] = translations[lang];
      } else {
        throw new Error(`Missing translation for ${key} in ${lang}`);
      }
    }
    const sorted = Object.fromEntries(
      Object.entries(current).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
    fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  }
}
