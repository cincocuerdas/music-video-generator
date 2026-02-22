import { describe, it, expect } from 'vitest';
import { enTranslations } from '../i18n/en';
import { esTranslations } from '../i18n/es';

/** Recursively collect all leaf keys from a translation dictionary */
function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
    const keys: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'object' && value !== null) {
            keys.push(...collectKeys(value as Record<string, unknown>, path));
        } else {
            keys.push(path);
        }
    }
    return keys;
}

describe('i18n translations', () => {
    const enKeys = collectKeys(enTranslations).sort();
    const esKeys = collectKeys(esTranslations).sort();

    it('en and es have the same number of keys', () => {
        expect(enKeys.length).toBe(esKeys.length);
    });

    it('every en key exists in es', () => {
        const missing = enKeys.filter(k => !esKeys.includes(k));
        expect(missing).toEqual([]);
    });

    it('every es key exists in en', () => {
        const extra = esKeys.filter(k => !enKeys.includes(k));
        expect(extra).toEqual([]);
    });

    it('no leaf values are empty strings', () => {
        const emptyEn = enKeys.filter(k => {
            const val = k.split('.').reduce((o: any, p) => o?.[p], enTranslations);
            return val === '';
        });
        const emptyEs = esKeys.filter(k => {
            const val = k.split('.').reduce((o: any, p) => o?.[p], esTranslations);
            return val === '';
        });
        expect(emptyEn).toEqual([]);
        expect(emptyEs).toEqual([]);
    });
});
