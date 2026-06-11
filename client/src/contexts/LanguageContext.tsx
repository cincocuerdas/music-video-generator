import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { loadTranslations } from '../i18n/loadTranslations';
import type { Language, TranslationDictionary } from '../i18n/types';

interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: (path: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);
const translationsCache = new Map<Language, TranslationDictionary>();
const FALLBACK_DICTIONARY: TranslationDictionary = {};

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [language, setLanguage] = useState<Language>(() => {
        // Check localStorage first, then browser language, default to 'es'
        const saved = localStorage.getItem('luma-lang') as Language;
        if (saved) return saved;

        const browserLang = navigator.language.split('-')[0];
        return browserLang === 'en' ? 'en' : 'es';
    });
    const [dictionary, setDictionary] = useState<TranslationDictionary | null>(null);

    useEffect(() => {
        localStorage.setItem('luma-lang', language);
        document.documentElement.lang = language;
    }, [language]);

    useEffect(() => {
        let isMounted = true;
        const cached = translationsCache.get(language);
        const pending = cached
            ? Promise.resolve(cached)
            : loadTranslations(language)
                .then((loaded) => { translationsCache.set(language, loaded); return loaded; })
                .catch(() => FALLBACK_DICTIONARY);

        pending.then((result) => { if (isMounted) setDictionary(result); });

        return () => { isMounted = false; };
    }, [language]);

    const t = useMemo(() => {
        const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

        return (path: string): string => {
            if (!dictionary) return path;
            const keys = path.split('.');
            let result: unknown = dictionary;

            for (const key of keys) {
                if (UNSAFE_KEYS.has(key)) {
                    return path;
                }
                if (result && typeof result === 'object' && key in result) {
                    result = (result as Record<string, unknown>)[key];
                } else {
                    return path; // Return path if key not found
                }
            }

            return typeof result === 'string' ? result : path;
        };
    }, [dictionary]);

    if (!dictionary) {
        return (
            <div className="min-h-screen bg-stitch-bg flex items-center justify-center text-gray-400 text-sm">
                Loading...
            </div>
        );
    }

    return (
        <LanguageContext.Provider value={{ language, setLanguage, t }}>
            {children}
        </LanguageContext.Provider>
    );
};

export const useLanguage = () => {
    const context = useContext(LanguageContext);
    if (!context) {
        throw new Error('useLanguage must be used within LanguageProvider');
    }
    return context;
};
