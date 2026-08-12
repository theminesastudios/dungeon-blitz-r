// Issue #668: Plague Battalion buffed the horde with a purely cosmetic buff -- no MeleeOverride,
// no RangedOverride -- so the aura played and no Poison was ever applied. The wiring is data, and
// data is exactly what rots silently, so every link in the chain is asserted here.
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const XML_DIR = path.resolve(__dirname, '../../client/content/xml');
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function block(xml: string, pattern: RegExp): string {
    const match = xml.match(pattern);
    assert.ok(match, `missing block for ${pattern}`);
    return match[0];
}

function tag(source: string, name: string): string {
    return source.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? '';
}

function main(): void {
    const powers = fs.readFileSync(path.join(XML_DIR, 'PlayerPowerTypes.xml'), 'utf8');
    const buffs = fs.readFileSync(path.join(XML_DIR, 'PlayerBuffTypes.xml'), 'utf8');
    const powerNames = new Set([...powers.matchAll(/<Power PowerName="([^"]*)">/g)].map((m) => m[1]));

    for (const rank of RANKS) {
        const casterBuff = block(buffs, new RegExp(`<BuffType BuffName="PlagueBattalion${rank}">[\\s\\S]*?</BuffType>`));
        const melee = tag(casterBuff, 'MeleeOverride');
        const ranged = tag(casterBuff, 'RangedOverride');
        assert.equal(melee, `PlagueBattalionMelee${rank}`, `caster buff ${rank} melee override`);
        assert.equal(ranged, `PlagueBattalionROR${rank}`, `caster buff ${rank} ranged override`);

        // Call the Horde raises melee-only minions. Giving their buff a ranged override handed
        // them a bolt they never had, which is what the horde was seen lobbing plague with.
        // AddSelfBuff and AddTargetBuff are separate fields for exactly this reason.
        const minionBuff = block(buffs, new RegExp(`<BuffType BuffName="PlagueBattalionMinion${rank}">[\\s\\S]*?</BuffType>`));
        assert.equal(tag(minionBuff, 'MeleeOverride'), `PlagueBattalionMelee${rank}`, `minion buff ${rank} melee`);
        assert.ok(!minionBuff.includes('RangedOverride'), `minion buff ${rank} must have no ranged override`);

        // A buff naming a power that does not exist is the bug PlagueBearer still has.
        assert.ok(powerNames.has(melee), `${melee} must exist in PlayerPowerTypes`);
        assert.ok(powerNames.has(ranged), `${ranged} must exist in PlayerPowerTypes`);

        for (const name of [melee, ranged]) {
            const power = block(powers, new RegExp(`<Power PowerName="${name}">[\\s\\S]*?</Power>`));
            const applied = tag(power, 'AddTargetBuff').split(',').map((entry) => entry.trim());
            assert.ok(applied.includes(`Plagued${rank}`), `${name} must apply its rank's poison`);
            // The override replaces the attack, so dropping this drops the attacker's damage.
            assert.equal(tag(power, 'BaseDamageMult'), '1', `${name} must keep normal attack damage`);
        }

        // Overriding Lich Shot must not quietly cost the Necromancer its third-shot debuff.
        const rangedPower = block(powers, new RegExp(`<Power PowerName="${ranged}">[\\s\\S]*?</Power>`));
        assert.ok(
            tag(rangedPower, 'AddTargetBuff').includes('MinorCurse'),
            `${ranged} must keep Lich Shot's MinorCurse`
        );

        // The cast hands the horde the melee-only buff and keeps the both-overrides one itself.
        const cast = block(powers, new RegExp(`<Power PowerName="PlagueBattalion${rank}">[\\s\\S]*?</Power>`));
        const targets = tag(cast, 'AddTargetBuff').split(',').map((entry) => entry.trim());
        assert.ok(
            targets.length > 0 && targets.every((entry) => entry === `PlagueBattalionMinion${rank}`),
            `rank ${rank} must buff the horde with the melee-only buff, got "${tag(cast, 'AddTargetBuff')}"`
        );
        assert.ok(
            tag(cast, 'AddSelfBuff').split(',').map((e) => e.trim()).includes(`PlagueBattalion${rank}`),
            `rank ${rank} must give the caster the both-overrides buff`
        );

        // One stack per target, by product decision -- four was authored but never played.
        const poison = block(buffs, new RegExp(`<BuffType BuffName="Plagued${rank}">[\\s\\S]*?</BuffType>`));
        assert.equal(tag(poison, 'StackCount'), '1', `Plagued${rank} must cap at one stack`);
    }

    // Ranks 8-10 apply the buff three times where 1-7 apply it once; that authored shape stays.
    for (const [rank, expected] of [[7, 1], [10, 3]] as const) {
        const cast = block(powers, new RegExp(`<Power PowerName="PlagueBattalion${rank}">[\\s\\S]*?</Power>`));
        assert.equal(
            tag(cast, 'AddTargetBuff').split(',').length,
            expected,
            `rank ${rank} authored buff repeat count must be preserved`
        );
    }

    // The invariant that would have caught the load failure: emptying ProjGfx on a projectile
    // power is a shape the client cannot parse, and none of the authored powers has it. Asserted
    // across the whole table rather than only the blocks this patch writes.
    for (const match of powers.matchAll(/<Power PowerName="([^"]*)">[\s\S]*?<\/Power>/g)) {
        const [body, name] = match;
        if (/<TargetMethod>Projectile[A-Za-z]*<\/TargetMethod>/.test(body)) {
            assert.ok(!body.includes('<ProjGfx/>'), `${name}: projectile power must author ProjGfx`);
        }
    }

    console.log('plague battalion override regression passed');
}

main();
