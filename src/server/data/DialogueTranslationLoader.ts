import fs from 'fs';
import path from 'path';
import { normalizeDialogueTextForClient } from './DialogueTextNormalizer';
import { localizeUnknownPortugueseText } from './PortugueseTextLocalizer';
import { localizeUnknownTurkishText } from './TurkishTextLocalizer';

type RawDialogueTranslationFile = {
    translations?: Record<string, string>;
};

type DialogueTranslationOptions = {
    fallbackToGeneric?: boolean;
    playerClass?: string;
    playerGender?: string;
};

type DialogueTranslationTemplate = {
    pattern: RegExp;
    placeholders: string[];
    translation: string;
};

export class DialogueTranslationLoader {
    private static readonly DEFAULT_LOCALE = 'en';
    private static readonly translationsByLocale: Map<string, Map<string, string>> = new Map();
    private static readonly translatedValuesByLocale: Map<string, Set<string>> = new Map();
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

    private static isFemaleGender(gender?: string): boolean {
        return String(gender ?? '').trim().toLowerCase() === 'female';
    }

    private static localizePlaceholderValue(locale: string, placeholder: string, value: string, gender?: string): string {
        if (this.normalizeLocale(locale) !== 'pt-br' || placeholder.toLowerCase() !== '#tc#') {
            return value;
        }

        const classNames: Record<string, { male: string; female: string }> = {
            mage: { male: 'Mago', female: 'Maga' },
            rogue: { male: 'Ladino', female: 'Ladina' },
            paladin: { male: 'Paladino', female: 'Paladina' }
        };

        const className = classNames[String(value ?? '').trim().toLowerCase()];
        if (!className) {
            return value;
        }
        return this.isFemaleGender(gender) ? className.female : className.male;
    }

    private static localizePortugueseClassPlaceholder(locale: string, text: string, playerClass?: string, playerGender?: string): string {
        if (this.normalizeLocale(locale) !== 'pt-br' || !/#tc#/i.test(text)) {
            return text;
        }

        const className = this.localizePlaceholderValue(locale, '#tc#', String(playerClass ?? '').trim(), playerGender);
        return className && className !== '#tc#'
            ? text.replace(/#tc#/gi, className)
            : text;
    }

    private static localizePortugueseGenderedTitles(locale: string, text: string, playerGender?: string): string {
        if (this.normalizeLocale(locale) !== 'pt-br') {
            return text;
        }

        const female = this.isFemaleGender(playerGender);
        const choose = (maleText: string, femaleText: string): string => female ? femaleText : maleText;
        let localized = String(text ?? '')
            .replace(/\bEle\|Ela\b/g, choose('Ele', 'Ela'))
            .replace(/\bele\|ela\b/g, choose('ele', 'ela'))
            .replace(/\bEle\|ela\b/g, choose('Ele', 'Ela'))
            .replace(/\bele\|Ela\b/g, choose('ele', 'ela'))
            .replace(/\bEsse\|Essa\b/g, choose('Esse', 'Essa'))
            .replace(/\besse\|essa\b/g, choose('esse', 'essa'))
            .replace(/\bdele\|dela\b/g, choose('dele', 'dela'))
            .replace(/\bDele\|Dela\b/g, choose('Dele', 'Dela'))
            .replace(/\bdo\|da\b/g, choose('do', 'da'))
            .replace(/\bDo\|Da\b/g, choose('Do', 'Da'))
            .replace(/\bele\|dela\b/g, choose('ele', 'ela'))
            .replace(/\bEle\|Dela\b/g, choose('Ele', 'Ela'))
            .replace(/\bmarujo\|maruja\b/g, choose('marujo', 'maruja'))
            .replace(/\bMarujo\|Maruja\b/g, choose('Marujo', 'Maruja'))
            .replace(/\bcara\|dama\b/g, choose('cara', 'dama'))
            .replace(/\bCara\|Dama\b/g, choose('Cara', 'Dama'))
            .replace(/\bIrmao\.\|Irma\./g, choose('Irmão.', 'Irmã.'))
            .replace(/\bIrmão\.\|Irmã\./g, choose('Irmão.', 'Irmã.'))
            .replace(/\bIrmao\|Irma\b/g, choose('Irmão', 'Irmã'))
            .replace(/\bIrmão\|Irmã\b/g, choose('Irmão', 'Irmã'))
            .replace(/\bum\|uma\b/g, choose('um', 'uma'))
            .replace(/\bUm\|Uma\b/g, choose('Um', 'Uma'))
            .replace(/\bo\|a\b/g, choose('o', 'a'))
            .replace(/\bO\|A\b/g, choose('O', 'A'))
            .replace(/\bintruso\|intrusa\b/g, choose('intruso', 'intrusa'))
            .replace(/\bIntruso\|Intrusa\b/g, choose('Intruso', 'Intrusa'))
            .replace(/\bforasteiro\|forasteira\b/g, choose('forasteiro', 'forasteira'))
            .replace(/\bForasteiro\|Forasteira\b/g, choose('Forasteiro', 'Forasteira'))
            .replace(/\bcaçador\|caçadora\b/g, choose('caçador', 'caçadora'))
            .replace(/\bCaçador\|Caçadora\b/g, choose('Caçador', 'Caçadora'))
            .replace(/\bdurão\|durona\b/g, choose('durão', 'durona'))
            .replace(/\bDurão\|Durona\b/g, choose('Durão', 'Durona'))
            .replace(/\bhumano\|humana\b/g, choose('humano', 'humana'))
            .replace(/\bHumano\|Humana\b/g, choose('Humano', 'Humana'))
            .replace(/\bobrigado\|obrigada\b/g, choose('obrigado', 'obrigada'))
            .replace(/\bObrigado\|Obrigada\b/g, choose('Obrigado', 'Obrigada'))
            .replace(/\bbem-vindo,\|bem-vinda,/g, choose('bem-vindo,', 'bem-vinda,'))
            .replace(/\bBem-vindo,\|Bem-vinda,/g, choose('Bem-vindo,', 'Bem-vinda,'))
            .replace(/\bbem-vindo\|bem-vinda\b/g, choose('bem-vindo', 'bem-vinda'))
            .replace(/\bBem-vindo\|Bem-vinda\b/g, choose('Bem-vindo', 'Bem-vinda'))
            .replace(/\bguerreiro\.\|guerreira\./g, choose('guerreiro.', 'guerreira.'))
            .replace(/\bGuerreiro\.\|Guerreira\./g, choose('Guerreiro.', 'Guerreira.'))
            .replace(/\bguerreiro\|guerreira\b/g, choose('guerreiro', 'guerreira'))
            .replace(/\bGuerreiro\|Guerreira\b/g, choose('Guerreiro', 'Guerreira'))
            .replace(/\bamigo\.\|amiga\./g, choose('amigo.', 'amiga.'))
            .replace(/\bAmigo\.\|Amiga\./g, choose('Amigo.', 'Amiga.'))
            .replace(/\bamigo\|amiga\b/g, choose('amigo', 'amiga'))
            .replace(/\bAmigo\|Amiga\b/g, choose('Amigo', 'Amiga'))
            .replace(/\bherói\|heroína\b/g, choose('herói', 'heroína'))
            .replace(/\bHerói\|Heroína\b/g, choose('Herói', 'Heroína'))
            .replace(/\bheroi\|heroina\b/g, choose('herói', 'heroína'))
            .replace(/\bHeroi\|Heroina\b/g, choose('Herói', 'Heroína'));

        if (!female) {
            return localized;
        }

        localized = localized
            .replace(/\bO Caçador do Kraken\b/g, 'A Caçadora do Kraken')
            .replace(/\bo Caçador do Kraken\b/g, 'a Caçadora do Kraken')
            .replace(/\bCaçador do Kraken\b/g, 'Caçadora do Kraken')
            .replace(/\bO humano\b/g, 'A humana')
            .replace(/\bo humano\b/g, 'a humana')
            .replace(/\bhumano\b/g, 'humana')
            .replace(/\bHumano\b/g, 'Humana')
            .replace(/\bnenhum hero[ií](?!na)\b/g, 'nenhuma heroína')
            .replace(/\bum hero[ií](?!na)\b/g, 'uma heroína')
            .replace(/\bhero[ií](?!na)\b/g, 'heroína')
            .replace(/\bHero[ií](?!na)\b/g, 'Heroína')
            .replace(/\bcampeão\b/g, 'campeã')
            .replace(/\bCampeão\b/g, 'Campeã')
            .replace(/\bmeu amigo\b/g, 'minha amiga')
            .replace(/\bMeu amigo\b/g, 'Minha amiga')
            .replace(/\bamigo ou inimigo\b/g, 'amiga ou inimiga')
            .replace(/\bAmigo ou inimigo\b/g, 'Amiga ou inimiga')
            .replace(/\bamigo\b/g, 'amiga')
            .replace(/\bAmigo\b/g, 'Amiga')
            .replace(/\bbem-vindo\b/g, 'bem-vinda')
            .replace(/\bBem-vindo\b/g, 'Bem-vinda')
            .replace(/\binimigo\b/g, 'inimiga')
            .replace(/\bInimigo\b/g, 'Inimiga')
            .replace(/\bmuito bom em\b/g, 'muito boa em')
            .replace(/\bMuito bom em\b/g, 'Muito boa em')
            .replace(/\bum caçador de goblins\b/g, 'uma caçadora de goblins')
            .replace(/\bUm caçador de goblins\b/g, 'Uma caçadora de goblins')
            .replace(/\bcaçador de goblins\b/g, 'caçadora de goblins')
            .replace(/\bCaçador de goblins\b/g, 'Caçadora de goblins')
            .replace(/\bgoblin-matador\b/g, 'goblin-matadora')
            .replace(/\bMatador de dragões\b/g, 'Matadora de dragões')
            .replace(/\bmatador de dragões\b/g, 'matadora de dragões')
            .replace(/\bAbridor de Caminho\b/g, 'Abridora de Caminho')
            .replace(/\babridor de caminho\b/g, 'abridora de caminho')
            .replace(/\bum guerreiro\b/g, 'uma guerreira')
            .replace(/\bUm guerreiro\b/g, 'Uma guerreira')
            .replace(/\bguerreiro\b/g, 'guerreira')
            .replace(/\bGuerreiro\b/g, 'Guerreira')
            .replace(/\bum aventureiro\b/g, 'uma aventureira')
            .replace(/\bUm aventureiro\b/g, 'Uma aventureira')
            .replace(/\baventureiro\b/g, 'aventureira')
            .replace(/\bAventureiro\b/g, 'Aventureira')
            .replace(/\bum lutador\b/g, 'uma lutadora')
            .replace(/\bUm lutador\b/g, 'Uma lutadora')
            .replace(/\blutador\b/g, 'lutadora')
            .replace(/\bLutador\b/g, 'Lutadora')
            .replace(/\bObrigado\b/g, 'Obrigada')
            .replace(/\bobrigado\b/g, 'obrigada');

        return localized;
    }

    private static localizePortugueseGenderedText(locale: string, text: string, playerGender?: string): string {
        if (this.normalizeLocale(locale) !== 'pt-br' || !this.isFemaleGender(playerGender)) {
            return this.localizePortugueseGenderedTitles(locale, text, playerGender);
        }

        return this.localizePortugueseGenderedTitles(locale, text, playerGender);
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

    private static translateTemplateText(
        locale: string,
        templates: DialogueTranslationTemplate[],
        text: string,
        playerGender?: string
    ): string {
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

                return template.translation.replace(/#(?:tn|tc)#/gi, (placeholder) => {
                    const value = valuesByPlaceholder.get(placeholder.toLowerCase()) ?? placeholder;
                    return this.localizePlaceholderValue(locale, placeholder, value, playerGender);
                });
            }
        }

        return '';
    }

    private static getTranslation(
        locale: string,
        translations: Map<string, string>,
        text: string,
        playerGender?: string
    ): string {
        const key = this.normalizeKey(text);
        const strippedKey = this.stripClientDirectives(key);
        return translations.get(key) ??
            translations.get(strippedKey) ??
            this.translateTemplateText(locale, this.translationTemplatesByLocale.get(locale) ?? [], text, playerGender);
    }

    private static isKnownTranslatedValue(locale: string, text: string): boolean {
        const values = this.translatedValuesByLocale.get(locale);
        if (!values) {
            return false;
        }

        const key = this.normalizeKey(text);
        return values.has(key) || values.has(this.stripClientDirectives(key));
    }

    private static translateCompositeText(
        locale: string,
        translations: Map<string, string>,
        text: string,
        playerGender?: string
    ): string {
        const parts = String(text ?? '').split(/(=@|=|:|\+\d+)/);
        if (parts.length <= 1) {
            return '';
        }

        let changed = false;
        const translated = parts.map((part) => {
            if (part === '=' || part === '=@' || /^\+\d+$/.test(part)) {
                return part;
            }

            const replacement = this.getTranslation(locale, translations, part, playerGender);
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
        this.translatedValuesByLocale.clear();
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
                const translatedValues = new Set<string>();
                const templates: DialogueTranslationTemplate[] = [];

                for (const [source, translated] of Object.entries(raw?.translations ?? {})) {
                    const key = this.normalizeKey(source);
                    const value = String(translated ?? '').trim();
                    if (!key || !value) {
                        continue;
                    }

                    translations.set(key, value);
                    translatedValues.add(this.normalizeKey(value));
                    translatedValues.add(this.stripClientDirectives(value));
                    this.addTranslationTemplate(templates, key, value);
                }

                this.translationsByLocale.set(locale, translations);
                this.translatedValuesByLocale.set(locale, translatedValues);
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

        const translated = this.getTranslation(normalizedLocale, translations, text, options.playerGender) ||
            this.translateCompositeText(normalizedLocale, translations, text, options.playerGender);
        if (!translated) {
            if (normalizedLocale === 'pt-br' && this.isKnownTranslatedValue(normalizedLocale, text)) {
                return normalizeDialogueTextForClient(
                    this.localizePortugueseGenderedText(
                        normalizedLocale,
                        this.localizePortugueseClassPlaceholder(
                            normalizedLocale,
                            text,
                            options.playerClass,
                            options.playerGender
                        ),
                        options.playerGender
                    ),
                    normalizedLocale
                );
            }
            if (options.fallbackToGeneric) {
                if (normalizedLocale === 'pt-br') {
                    return localizeUnknownPortugueseText(text);
                }
                return normalizeDialogueTextForClient(
                    this.translateUnknownRoomThought(text),
                    normalizedLocale
                );
            }
            if (normalizedLocale === 'tr' && this.looksLikeEnglishText(this.stripClientDirectives(text))) {
                return localizeUnknownTurkishText(text);
            }
            if (normalizedLocale === 'pt-br' && this.looksLikeEnglishText(this.stripClientDirectives(text))) {
                return localizeUnknownPortugueseText(text);
            }
            return text;
        }

        return normalizeDialogueTextForClient(
            this.localizePortugueseGenderedText(
                normalizedLocale,
                this.localizePortugueseClassPlaceholder(
                    normalizedLocale,
                    translated,
                    options.playerClass,
                    options.playerGender
                ),
                options.playerGender
            ),
            normalizedLocale
        );
    }
}
