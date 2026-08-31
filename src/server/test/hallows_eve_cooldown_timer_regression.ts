/**
 * Regression test for the Green Knight's twelve-hour clock, as the panel sees it.
 *
 * `a_ScreenHalloweenDungeonPrompt` draws its own countdown - it always could - but
 * only from `mMasterClassTower.mEndtime`, and the one packet that can set that field
 * outside the login block is 0xD5. So the whole visible half of the cooldown is two
 * numbers in one packet, and this pins their shape:
 *
 *   - sleeping: a non-zero tower index and a **deadline in unix seconds**, which is
 *     what `SetCurrentResearch` turns into the "busy" state the panel switches on;
 *   - awake: `(0, 0)`, the idle state, which is the panel's "he has returned".
 *
 * The client half is `scripts/patch-dungeonblitz-hallows-eve-cooldown-timer.ts`,
 * which makes 0xD5's reader take the deadline off the packet instead of hardcoding
 * zero. If that patch is ever lost the panel goes quiet; if *this* shape drifts, the
 * panel counts down to the wrong moment, which is worse.
 */
import {
    HallowsEve,
    HALLOWS_EVE_KEY_COOLDOWN_SECONDS,
    HALLOWS_EVE_SUMMON_COST_IDOLS,
    HALLOWS_EVE_ENDS_AT,
    describeHallowsEveWindow
} from '../core/HallowsEve';
import { BitReader } from '../network/protocol/bitReader';

const TIMER_PACKET_ID = 0xd5;

interface SentPacket {
    opcode: number;
    data: Buffer;
}

function makeClient(character: any, currentLevel: string) {
    const sent: SentPacket[] = [];
    return {
        character,
        currentLevel,
        sent,
        sendBitBuffer(opcode: number, bb: any): void {
            sent.push({ opcode, data: bb.toBuffer() });
        }
    };
}

function readTimer(packet: SentPacket): { index: number; deadline: number } {
    const br = new BitReader(packet.data);
    return { index: br.readMethod6(2), deadline: br.readMethod4() };
}

let failures = 0;
let assertions = 0;

function check(label: string, condition: boolean): void {
    assertions += 1;
    if (condition) {
        console.log(`PASS  ${label}`);
        return;
    }
    failures += 1;
    console.error(`FAIL  ${label}`);
}

const now = Math.floor(Date.now() / 1000);

// 1. Never fought him: the panel must say he is up.
{
    const client = makeClient({ name: 'Ready', mMasterClass: 'templar' }, 'SwampRoadNorth');
    HallowsEve.sendCooldownTimer(client);
    check('a character with no kill on record is sent one packet', client.sent.length === 1);
    check('and it is 0xD5', client.sent[0]?.opcode === TIMER_PACKET_ID);
    const timer = readTimer(client.sent[0]);
    check('with no tower index', timer.index === 0);
    check('and no deadline - which is the panel\'s "he has returned"', timer.deadline === 0);
}

// 2. Just killed him: a real deadline, twelve hours out.
{
    const character = {
        name: 'Waiting',
        mMasterClass: 'templar',
        hallowsEveLastKnightAt: now - 60
    };
    const client = makeClient(character, 'SwampRoadNorth');
    HallowsEve.sendCooldownTimer(client);
    const timer = readTimer(client.sent[0]);
    const expected = now - 60 + HALLOWS_EVE_KEY_COOLDOWN_SECONDS;
    check('a character inside the window is given a non-zero tower index', timer.index > 0);
    check('the index is the one the client maps templar to', timer.index === 3);
    check(
        `the deadline is the kill plus twelve hours (${timer.deadline} vs ${expected})`,
        Math.abs(timer.deadline - expected) <= 2
    );
    check(
        'and it is still in the future, which is what makes the panel count',
        timer.deadline > Math.floor(Date.now() / 1000)
    );
}

// 3. An expired window reads as awake, not as a deadline in the past.
{
    const client = makeClient(
        { name: 'Expired', mMasterClass: 'flameseer', hallowsEveLastKnightAt: now - HALLOWS_EVE_KEY_COOLDOWN_SECONDS - 5 },
        'SwampRoadNorth'
    );
    HallowsEve.sendCooldownTimer(client);
    const timer = readTimer(client.sent[0]);
    check('an elapsed cooldown is sent as idle, not as a stale deadline', timer.index === 0 && timer.deadline === 0);
}

// 4. Paying for the summon clears the clock the panel is counting.
{
    const character = {
        name: 'Buyer',
        mMasterClass: 'sentinel',
        hallowsEveFirstEntryAt: now - 1000,
        hallowsEveLastKnightAt: now - 60,
        mammothIdols: HALLOWS_EVE_SUMMON_COST_IDOLS
    };
    const client = makeClient(character, 'SwampRoadNorth');
    HallowsEve.sendCooldownTimer(client);
    check('before paying, the panel is counting', readTimer(client.sent[0]).deadline > 0);

    const outcome = HallowsEve.summonKnightNow(character);
    check('twenty idols buys the summon', outcome === 'summoned');
    check('and they are spent', Number(character.mammothIdols) === 0);

    client.sent.length = 0;
    HallowsEve.sendCooldownTimer(client);
    const after = readTimer(client.sent[0]);
    check('after paying, the panel is told he is up', after.index === 0 && after.deadline === 0);
}

// 5. Short of idols, the clock stands - the wait is the thing being sold.
{
    const character = {
        name: 'Poor',
        mMasterClass: 'sentinel',
        hallowsEveFirstEntryAt: now - 1000,
        hallowsEveLastKnightAt: now - 60,
        mammothIdols: HALLOWS_EVE_SUMMON_COST_IDOLS - 1
    };
    check('a player who cannot pay is refused', HallowsEve.summonKnightNow(character) === 'poor');
    check('and keeps their idols', Number(character.mammothIdols) === HALLOWS_EVE_SUMMON_COST_IDOLS - 1);
    const client = makeClient(character, 'SwampRoadNorth');
    HallowsEve.sendCooldownTimer(client);
    check('and the panel is still counting', readTimer(client.sent[0]).deadline > 0);
}

// 6. The first visit is free, and it does not start a clock.
{
    const character = { name: 'First', mMasterClass: 'sentinel', mammothIdols: 0 };
    check('a first visit costs nothing', HallowsEve.summonKnightNow(character) === 'first');
    const client = makeClient(character, 'SwampRoadNorth');
    HallowsEve.sendCooldownTimer(client);
    check('and leaves the panel saying he is up', readTimer(client.sent[0]).deadline === 0);
}

/**
 * 7. The top-left HUD.
 *
 * The bar's announcement is artwork now and the field that used to hold it was moved down
 * beside the skull and the key plate, so the headline the server sends *is* the key count.
 * This pins the five fields going out in the order
 * `class_116.method_690(icon, url, title, tooltip, endsAt)` reads them - get it wrong and
 * the bar shows a URL where the count should be.
 */
{
    const client = makeClient({ name: 'Reader', mMasterClass: 'templar' }, 'SwampRoadNorth');
    HallowsEve.sendNewsUpdate(client);
    check('the HUD is sent one packet', client.sent.length === 1);
    check('and it is 0x103, the news update', client.sent[0]?.opcode === 0x103);

    const br = new BitReader(client.sent[0].data);
    br.readMethod13();
    const url = br.readMethod13();
    const title = br.readMethod13();
    br.readMethod13();
    const endsAt = br.readMethod4();
    check('a character with no keys reads x0', title === 'x0');
    check('the link is still the studio\'s', url === 'https://theminesa.studio');
    check('and the bar keeps its own clock', endsAt > Math.floor(Date.now() / 1000));
}

// 8. The count, and the one rule the field cannot break.
{
    const count = (keys: number) => HallowsEve.newsHeadline({ hallowsEveKeys: keys }).title;
    check('no keys reads x0', count(0) === 'x0');
    check('two keys reads x2', count(2) === 'x2');
    check('twelve keys reads x12 - the plate has room and the number is true', count(12) === 'x12');
    check(
        'the tooltip only speaks up when there is a key to spend',
        HallowsEve.newsHeadline({ hallowsEveKeys: 0 }).tooltip === '' &&
            /coffers in the square/.test(HallowsEve.newsHeadline({ hallowsEveKeys: 1 }).tooltip)
    );
    check('one key is singular', /1 Green Knight coffer key\./.test(HallowsEve.newsHeadline({ hallowsEveKeys: 1 }).tooltip));

    /**
     * `class_132.Refresh` hides the whole bar - static announcement included - when the
     * headline is empty, so the field is never allowed to be.
     */
    const after = HallowsEve.newsHeadline({ hallowsEveKeys: 3 }, HALLOWS_EVE_ENDS_AT + 1);
    check('after the event the count goes but the headline is not empty', after.title === ' ');
    check('and every state before that is non-empty too', [0, 1, 12].every((n) => count(n).length > 0));
}

// 9. The event window reads coarsely, and never as "0 Days".
{
    check('a week out reads in days', describeHallowsEveWindow(7 * 86400) === '7 Days');
    check('the last day reads in hours', describeHallowsEveWindow(5 * 3600) === '5 Hours');
    check('one day is singular', describeHallowsEveWindow(86400 + 60) === '1 Day');
    check('the last hour has its own name', describeHallowsEveWindow(600) === 'Final Hour');
}

console.log(`\nHallow's Eve cooldown timer: ${assertions} assertions, ${failures} failed.`);
if (failures > 0) {
    process.exit(1);
}
