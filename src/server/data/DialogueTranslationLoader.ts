import fs from 'fs';
import path from 'path';
import { normalizeDialogueTextForClient } from './DialogueTextNormalizer';
import { localizeUnknownTurkishText } from './TurkishTextLocalizer';

type RawDialogueTranslationFile = {
    translations?: Record<string, string>;
};

type DialogueTranslationOptions = {
    fallbackToGeneric?: boolean;
};

type DialogueTranslationTemplate = {
    pattern: RegExp;
    placeholders: string[];
    translation: string;
};

export class DialogueTranslationLoader {
    private static readonly DEFAULT_LOCALE = 'en';
    private static readonly translationsByLocale: Map<string, Map<string, string>> = new Map();
    private static readonly translationTemplatesByLocale: Map<string, DialogueTranslationTemplate[]> = new Map();
    private static loaded = false;
    private static readonly HELP_FALLBACKS = [
        'Yardim edin!',
        'Beni koruyun!',
        'Buraya yardim gerek!'
    ];
    private static readonly WARNING_FALLBACKS = [
        'Dikkat!',
        'Tetikte olun!',
        'Tehlike yakinda!'
    ];
    private static readonly FIRE_FALLBACKS = [
        'Her sey yanacak!',
        'Kule doneceksin!',
        'Alevler seni yutacak!'
    ];
    private static readonly KILL_FALLBACKS = [
        'Seni yok edecegim!',
        'Burada oleceksin!',
        'Seni parcalayacagim!',
        'Sonun geldi!',
        'Kanini dokecegim!',
        'Seni mezara gonderecegim!'
    ];
    private static readonly ATTACK_FALLBACKS = [
        'Saldiriya gecin!',
        'Ustune gidin!',
        'Onu durdurun!',
        'Hucum edin!',
        'Etrafini sarin!',
        'Savasa hazirlanin!'
    ];
    private static readonly INTRUDER_FALLBACKS = [
        'Davetsiz misafir!',
        'Yabanci burada!',
        'Hirsizi yakalayin!',
        'Buraya ait degilsin!',
        'Ihlalciyi durdurun!'
    ];
    private static readonly GENERIC_ENEMY_FALLBACKS = [
        'Geri cekil!',
        'Buradan gecemezsin!',
        'Sana izin vermeyecegiz!',
        'Bunu odetecegiz!',
        'Kaderin burada bitecek!',
        'Gucumuzu goreceksin!',
        'Karsimiza cikmamaliydin!',
        'Burasi bizim bolgemiz!'
    ];

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
                .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
                .replace(/^(?:\s*<[^>]+>\s*)+/, '')
                .replace(/^\^t\s*/, '')
        );
    }

    private static escapeRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private static compileTranslationTemplate(source: string, translation: string): DialogueTranslationTemplate | null {
        const sourceKey = this.normalizeKey(source);
        if (!/#(?:tn|tc)#/i.test(sourceKey) && !/[A-Za-z][A-Za-z'!.?]*\|[A-Za-z][A-Za-z'!.?]*/.test(sourceKey)) {
            return null;
        }

        const placeholders: string[] = [];
        const pieces = sourceKey.split(/(#(?:tn|tc)#|[A-Za-z][A-Za-z'!.?]*\|[A-Za-z][A-Za-z'!.?]*)/gi);
        const pattern = pieces.map((piece) => {
            if (/^#(?:tn|tc)#$/i.test(piece)) {
                placeholders.push(piece.toLowerCase());
                return '(.+?)';
            }
            if (/^[A-Za-z][A-Za-z'!.?]*\|[A-Za-z][A-Za-z'!.?]*$/.test(piece)) {
                const [left, right] = piece.split('|');
                return `(?:${this.escapeRegex(left)}|${this.escapeRegex(right)})`;
            }

            return this.escapeRegex(piece);
        }).join('');

        return {
            pattern: new RegExp(`^${pattern}$`),
            placeholders,
            translation
        };
    }

    private static addTranslationTemplate(
        templates: DialogueTranslationTemplate[],
        source: string,
        translation: string
    ): void {
        const sources = [this.normalizeKey(source), this.stripClientDirectives(source)];
        const seen = new Set<string>();

        for (const sourceVariant of sources) {
            if (!sourceVariant || seen.has(sourceVariant)) {
                continue;
            }
            seen.add(sourceVariant);

            const template = this.compileTranslationTemplate(sourceVariant, translation);
            if (template) {
                templates.push(template);
            }
        }
    }

    private static translateTemplateText(templates: DialogueTranslationTemplate[], text: string): string {
        const keys = [this.normalizeKey(text), this.stripClientDirectives(text)];
        const seen = new Set<string>();

        for (const key of keys) {
            if (!key || seen.has(key)) {
                continue;
            }
            seen.add(key);

            for (const template of templates) {
                const match = template.pattern.exec(key);
                if (!match) {
                    continue;
                }

                const valuesByPlaceholder = new Map<string, string>();
                template.placeholders.forEach((placeholder, index) => {
                    if (!valuesByPlaceholder.has(placeholder)) {
                        valuesByPlaceholder.set(placeholder, match[index + 1] ?? '');
                    }
                });

                return template.translation.replace(/#(?:tn|tc)#/gi, (placeholder) =>
                    valuesByPlaceholder.get(placeholder.toLowerCase()) ?? placeholder
                );
            }
        }

        return '';
    }

    private static getTranslation(locale: string, translations: Map<string, string>, text: string): string {
        const key = this.normalizeKey(text);
        const strippedKey = this.stripClientDirectives(key);
        return translations.get(key) ??
            translations.get(strippedKey) ??
            this.translateTemplateText(this.translationTemplatesByLocale.get(locale) ?? [], text);
    }

    private static translateCompositeText(locale: string, translations: Map<string, string>, text: string): string {
        const parts = String(text ?? '').split(/(=@|=|:|\+\d+)/);
        if (parts.length <= 1) {
            return '';
        }

        let changed = false;
        const translated = parts.map((part) => {
            if (part === '=' || part === '=@' || /^\+\d+$/.test(part)) {
                return part;
            }

            const replacement = this.getTranslation(locale, translations, part);
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

    private static pickFallback(text: string, choices: string[]): string {
        if (!choices.length) {
            return text;
        }

        let hash = 0;
        for (const char of String(text ?? '')) {
            hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
        }

        return choices[Math.abs(hash) % choices.length];
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
            return this.pickFallback(clean, this.HELP_FALLBACKS);
        }
        if (/\b(warning|beware)\b/i.test(clean)) {
            return this.pickFallback(clean, this.WARNING_FALLBACKS);
        }
        if (/\b(Nephit)\b/i.test(clean)) {
            return 'Nephit icin!';
        }
        if (/\b(Emperor)\b/i.test(clean)) {
            return 'Imparator icin!';
        }
        if (/\b(burn|fire|ashes|ash)\b/i.test(clean)) {
            return this.pickFallback(clean, this.FIRE_FALLBACKS);
        }
        if (/\b(die|kill|slay|destroy|annihilation|curse|blood)\b/i.test(clean)) {
            return this.pickFallback(clean, this.KILL_FALLBACKS);
        }
        if (/\b(come|rise|charge|attack|swarm|defend|guard|to me)\b/i.test(clean)) {
            return this.pickFallback(clean, this.ATTACK_FALLBACKS);
        }
        if (/\b(human|trespasser|thief|thieves|usurper)\b/i.test(clean)) {
            return this.pickFallback(clean, this.INTRUDER_FALLBACKS);
        }

        return this.pickFallback(clean, this.GENERIC_ENEMY_FALLBACKS);
    }

    static load(dataDir: string): void {
        this.translationsByLocale.clear();
        this.translationTemplatesByLocale.clear();
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
                const templates: DialogueTranslationTemplate[] = [];

                for (const [source, translated] of Object.entries(raw?.translations ?? {})) {
                    const key = this.normalizeKey(source);
                    const value = String(translated ?? '').trim();
                    if (!key || !value) {
                        continue;
                    }

                    translations.set(key, value);
                    this.addTranslationTemplate(templates, key, value);
                }

                this.translationsByLocale.set(locale, translations);
                this.translationTemplatesByLocale.set(locale, templates);
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

        const translated = this.getTranslation(normalizedLocale, translations, text) ||
            this.translateCompositeText(normalizedLocale, translations, text);
        if (!translated) {
            if (options.fallbackToGeneric) {
                return normalizeDialogueTextForClient(
                    this.translateUnknownRoomThought(text),
                    normalizedLocale
                );
            }
            if (normalizedLocale === 'tr' && this.looksLikeEnglishText(this.stripClientDirectives(text))) {
                return localizeUnknownTurkishText(text);
            }
            return text;
        }

        return normalizeDialogueTextForClient(translated, normalizedLocale);
    }
}
