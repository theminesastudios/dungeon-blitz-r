/**
 * The top-left news bar, and what it says.
 *
 * `class_132` is the one persistent, server-fed HUD this client draws - `Game` calls
 * `Display()` on it beside `screenHud` - and all of it is five strings and a time:
 *
 *     class_116.method_690(icon, url, title, tooltip, endsAt)
 *
 * `title` is the line in the bar, `tooltip` is the paragraph behind the hover with the
 * client's own countdown to `endsAt` under it, `url` is what "View event details" opens,
 * and **`icon` is a symbol name** resolved through `ApplicationDomain.currentDomain` at
 * refresh time.
 *
 * The announcement itself is the studio's and stays the studio's. The only part a seasonal
 * event borrows is that icon, which is why `icon` is the one thing `build` takes: a name
 * can stand for any drawing, of any size, anywhere - `scripts/patch-ui0-hallows-eve-badge.ts`
 * hangs the Green Knight's skull and key count *below* the bar that way, without the
 * announcement moving or changing a word.
 *
 * This lives on its own so that both senders can share it without importing each other:
 * `WorldEnter` writes these fields into the login packet and `HallowsEve.sendNewsUpdate`
 * sends the same five on 0x103 when the count changes.
 */
export interface NewsHudFields {
    icon: string;
    url: string;
    title: string;
    tooltip: string;
    endsAt: number;
}

/** The announcement the bar carries when nothing is borrowing its icon. */
const STUDIO_BANNER = {
    icon: 'a_NewsPetXPIcon',
    url: 'https://theminesa.studio',
    title: 'The Minesa Studios',
    tooltip: 'https://theminesa.studio'
};

/**
 * How long the bar's own clock runs for.
 *
 * The banner is not an event and has no end, so this is simply a long time - the number
 * the announcement has always been sent with.
 */
const BANNER_REMAINING_SECONDS = 666 * 60 * 60;

export class NewsHud {
    /**
     * The five fields, with the headline and the hover text borrowed when there is
     * something more useful to say than the announcement.
     *
     * The **icon is not offered as an override**, on purpose: `class_4.method_16` has never
     * resolved a name on this server - the shipped `a_NewsGoldIcon` does not draw either -
     * so anything hung there is invisible. Artwork goes into the screen itself instead; see
     * `scripts/patch-ui-seasonal-news-hud-badge.ts`.
     */
    static build(
        overrides: { title?: string | null; tooltip?: string | null } = {},
        nowSeconds = Math.floor(Date.now() / 1000)
    ): NewsHudFields {
        return {
            icon: STUDIO_BANNER.icon,
            url: STUDIO_BANNER.url,
            title: overrides.title || STUDIO_BANNER.title,
            tooltip: overrides.tooltip || STUDIO_BANNER.tooltip,
            endsAt: nowSeconds + BANNER_REMAINING_SECONDS
        };
    }
}
