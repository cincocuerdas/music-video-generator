import type { Language, TranslationDictionary } from './types';

export async function loadTranslations(language: Language): Promise<TranslationDictionary> {
  if (language === 'en') {
    const module = await import('./en');
    return module.enTranslations;
  }

  const module = await import('./es');
  return module.esTranslations;
}

