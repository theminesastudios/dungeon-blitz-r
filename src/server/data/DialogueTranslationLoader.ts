import fs from 'fs';
import path from 'path';
import { normalizeDialogueTextForClient } from './DialogueTextNormalizer';

type RawDialogueTranslationFile = {
    translations?: Record<string, string>;
};

type DialogueTranslationOptions = {
    fallbackToGeneric?: boolean;
};

export class DialogueTranslationLoader {
    private static readonly DEFAULT_LOCALE = 'en';
    private static readonly translationsByLocale: Map<string, Map<string, string>> = new Map();
    private static loaded = false;

    private static normalizeLocale(locale: string): string {
        const normalized = String(locale ?? '').trim().toLowerCase();
        return normalized || this.DEFAULT_LOCALE;
    }

    private static normalizeKey(value: string): string {
        return String(value ?? '').trim().replace(/\s+/g, ' ');
    }

    private static stripClientDirectives(value: string): string {
        return this.normalizeKey(
            String(value ?? '')
                .replace(/^[@:]+/, '')
                .replace(/^(?:\s*<[^>]+>\s*)+/, '')
                .replace(/^\^t\s*/, '')
        );
    }

    private static getTranslation(translations: Map<string, string>, text: string): string {
        const key = this.normalizeKey(text);
        const strippedKey = this.stripClientDirectives(key);
        return translations.get(key) ?? translations.get(strippedKey) ?? '';
    }

    private static translateCompositeText(translations: Map<string, string>, text: string): string {
        const parts = String(text ?? '').split(/(=@|=)/);
        if (parts.length <= 1) {
            return '';
        }

        let changed = false;
        const translated = parts.map((part) => {
            if (part === '=' || part === '=@') {
                return part;
            }

            const replacement = this.getTranslation(translations, part);
            if (!replacement) {
                return part;
            }

            changed = true;
            return replacement;
        }).join('');

        return changed ? translated : '';
    }

    private static looksLikeEnglishText(text: string): boolean {
        return /[A-Za-z]{2,}/.test(text);
    }

    private static translateUnknownRoomThought(text: string): string {
        const clean = this.stripClientDirectives(text);
        if (!this.looksLikeEnglishText(clean)) {
            return text;
        }

        if (/^nothing\.?$/i.test(clean)) {
            return 'Hicbir sey.';
        }
        if (/\b(help|save|protect)\b/i.test(clean)) {
            return 'Yardim edin!';
        }
        if (/\b(warning|beware)\b/i.test(clean)) {
            return 'Dikkat!';
        }
        if (/\b(Meylour)\b/i.test(clean)) {
            return 'Meylour icin!';
        }
        if (/\b(Nephit)\b/i.test(clean)) {
            return 'Nephit icin!';
        }
        if (/\b(Emperor)\b/i.test(clean)) {
            return 'Imparator icin!';
        }
        if (/\b(burn|fire|ashes|ash)\b/i.test(clean)) {
            return 'Her sey yanacak!';
        }
        if (/\b(die|kill|slay|destroy|annihilation|curse|blood)\b/i.test(clean)) {
            return 'Geber!';
        }
        if (/\b(come|rise|charge|attack|swarm|defend|guard|to me)\b/i.test(clean)) {
            return 'Saldirin!';
        }
        if (/\b(human|trespasser|thief|thieves|usurper)\b/i.test(clean)) {
            return 'Davetsiz misafir!';
        }

        return 'Saldirin!';
    }

    static load(dataDir: string): void {
        this.translationsByLocale.clear();
        this.loaded = false;

        try {
            const files = fs.readdirSync(dataDir);
            for (const file of files) {
                const match = /^DialogueTranslations\.([a-z-]+)\.json$/i.exec(file);
                if (!match) {
                    continue;
                }

                const locale = this.normalizeLocale(match[1]);
                const raw = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as RawDialogueTranslationFile;
                const translations = new Map<string, string>();

                for (const [source, translated] of Object.entries(raw?.translations ?? {})) {
                    const key = this.normalizeKey(source);
                    const value = String(translated ?? '').trim();
                    if (!key || !value) {
                        continue;
                    }

                    translations.set(key, value);
                }

                this.translationsByLocale.set(locale, translations);
            }

            this.loaded = true;
            console.log(`[DialogueTranslationLoader] Loaded dialogue translation locales: ${[...this.translationsByLocale.keys()].join(', ') || 'none'}.`);
        } catch (error) {
            console.error(`[DialogueTranslationLoader] Failed to load dialogue translations: ${error}`);
        }
    }

    static isLoaded(): boolean {
        return this.loaded;
    }

    static translateText(text: string, locale: string, options: DialogueTranslationOptions = {}): string {
        const normalizedLocale = this.normalizeLocale(locale);
        if (normalizedLocale === this.DEFAULT_LOCALE) {
            return text;
        }

        const translations = this.translationsByLocale.get(normalizedLocale);
        if (!translations) {
            return text;
        }

        const translated = this.getTranslation(translations, text) || this.translateCompositeText(translations, text);
        if (!translated) {
            if (options.fallbackToGeneric) {
                return normalizeDialogueTextForClient(
                    this.translateUnknownRoomThought(text),
                    normalizedLocale
                );
            }
            return text;
        }

        return normalizeDialogueTextForClient(translated, normalizedLocale);
    }
}
