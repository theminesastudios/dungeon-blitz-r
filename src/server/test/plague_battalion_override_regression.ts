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
        const buff = block(buffs, new RegExp(`<BuffType BuffName="PlagueBattalion${rank}">[\\s\\S]*?</BuffType>`));
        const melee = tag(buff, 'MeleeOverride');
        const ranged = tag(buff, 'RangedOverride');
        assert.equal(melee, `PlagueBattalionMelee${rank}`, `rank ${rank} melee override`);
        assert.equal(ranged, `PlagueBattalionROR${rank}`, `rank ${rank} ranged override`);

        // A buff naming a power that does not exist is the bug PlagueBearer still has.
        assert.ok(powerNames.has(melee), `${melee} must exist in PlayerPowerTypes`);
        assert.ok(powerNames.has(ranged), `${ranged} must exist in PlayerPowerTypes`);

        for (const name of [melee, ranged]) {
            const power = block(powers, new RegExp(`<Power PowerName="${name}">[\\s\\S]*?</Power>`));
            assert.equal(tag(power, 'AddTargetBuff'), `Plagued${rank}`, `${name} must apply its rank's poison`);
            // The override replaces the attack, so dropping this drops the minion's damage.
            assert.equal(tag(power, 'BaseDamageMult'), '1', `${name} must keep normal attack damage`);
        }

        // The cast has to hand out the ranked buff, or the overrides above are never reached.
        const cast = block(powers, new RegExp(`<Power PowerName="PlagueBattalion${rank}">[\\s\\S]*?</Power>`));
        const targets = tag(cast, 'AddTargetBuff').split(',');
        assert.ok(
            targets.length > 0 && targets.every((entry) => entry === `PlagueBattalion${rank}`),
            `rank ${rank} must buff the horde with its own ranked buff, got "${tag(cast, 'AddTargetBuff')}"`
        );
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


    // Issue #668 follow-up: one stack per target, and no plague projectile of its own -- the
    // minion shoots what it normally shoots and the poison rides along.
    for (const rank of RANKS) {
        const poison = block(buffs, new RegExp(`<BuffType BuffName="Plagued${rank}">[\\s\\S]*?</BuffType>`));
        assert.equal(tag(poison, 'StackCount'), '1', `Plagued${rank} must cap at one stack`);

        const ranged = block(powers, new RegExp(`<Power PowerName="PlagueBattalionROR${rank}">[\\s\\S]*?</Power>`));
        // Emptying this is what stopped Game.swz loading at all: the client will not parse a
        // ProjectilePlayer power with no projectile art. Kept small rather than absent.
        assert.ok(!ranged.includes('<ProjGfx/>'), `ROR${rank} must author projectile art`);
    }


    // The invariant that would have caught it: a projectile power without projectile art is a
    // shape the client cannot load, and none of the authored 1711 powers has it.
    for (const block_ of powers.matchAll(/<Power PowerName="([^"]*)">[\s\S]*?<\/Power>/g)) {
        const [body, name] = block_;
        if (body.includes('<TargetMethod>ProjectilePlayer</TargetMethod>')) {
            assert.ok(!body.includes('<ProjGfx/>'), `${name}: ProjectilePlayer power must author ProjGfx`);
        }
    }

    console.log('plague battalion override regression passed');
}

main();
