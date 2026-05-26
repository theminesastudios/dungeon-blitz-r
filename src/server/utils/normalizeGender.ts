export function normalizeGender(value: unknown): string {
    const raw = String(value ?? '').trim();
    const lowered = raw.toLowerCase();

    if (lowered === 'male') {
        return 'Male';
    }

    if (lowered === 'female') {
        return 'Female';
    }

    return raw;
}

/**
 * Resolves character gender from the client-sent gender string, falling back to
 * visual asset names when the client sends an empty or unrecognized value.
 *
 * Flash asset naming convention:
 *   Female: FemaleHead*, FDo*, FMouth*, FFace*
 *   Male:   MaleHead*,   MDo*, MM*,    MF*
 */
export function resolveCharacterGender(
    gender: unknown,
    headSet: string,
    hairSet: string,
    mouthSet: string,
    faceSet: string
): string {
    const normalized = normalizeGender(gender);
    if (normalized === 'Male' || normalized === 'Female') {
        return normalized;
    }

    // Infer from visual asset names (most reliable signal)
    const parts = [headSet, hairSet, mouthSet, faceSet];
    for (const part of parts) {
        if (/female/i.test(part)) return 'Female';
    }
    for (const part of parts) {
        if (/^FDo/i.test(part) || /^FMouth/i.test(part) || /^FFace/i.test(part)) return 'Female';
    }

    return 'Male';
}
