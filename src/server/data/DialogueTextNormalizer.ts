const TURKISH_ASCII_MAP: Record<string, string> = {
    Ç: 'C',
    Ö: 'O',
    Ş: 'S',
    Ü: 'U',
    Ğ: 'G',
    İ: 'I',
    ç: 'c',
    ö: 'o',
    ş: 's',
    ü: 'u',
    ğ: 'g',
    ı: 'i'
};

function normalizeLocale(locale: string): string {
    return String(locale ?? '').trim().toLowerCase();
}

export function normalizeDialogueTextForClient(text: string, locale: string): string {
    const normalizedLocale = normalizeLocale(locale);
    if (normalizedLocale === 'pt-br') {
        return text;
    }

    if (normalizedLocale !== 'tr') {
        return text;
    }

    return String(text ?? '').replace(/[ÇÖŞÜĞİçöüğışı]/g, (character) => TURKISH_ASCII_MAP[character] ?? character);
}

export function normalizeDialogueLinesForClient(lines: string[], locale: string): string[] {
    return lines.map((line) => normalizeDialogueTextForClient(line, locale));
}
