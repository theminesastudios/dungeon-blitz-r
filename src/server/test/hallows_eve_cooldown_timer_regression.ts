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
    HALLOWS_EVE_SUMMON_COST_IDOLS
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

console.log(`\nHallow's Eve cooldown timer: ${assertions} assertions, ${failures} failed.`);
if (failures > 0) {
    process.exit(1);
}
