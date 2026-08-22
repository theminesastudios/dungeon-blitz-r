import { strict as assert } from 'assert';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';

// A client's own body id must survive combat id resolution untouched.
//
// `resolveClientHostileEntityAlias` refuses to translate `client.clientEntID`, but it used to run
// SECOND -- on whatever `EntityHandler.resolveEntityAlias` had already turned that id into. So a
// stray entry for the player's own id in `entityIdAliases` rewrote the source of their own swing,
// `resolveCombatSourceSession` (which matches on `clientEntID === sourceId`) then failed to find
// the attacker, and `isAuthorizedNetworkCombatSource` refused the hit.
//
// Live symptom: two players in The East Wing, one member's swings dropped wholesale --
// `Lanorut:0/169375 hits=0 dropped=20:unauthorized_source` against a 161472 pool -- so only the
// other member's damage reached the canonical and enemies died with the bar part-full.

function makeClient(clientEntID: number): any {
    return {
        clientEntID,
        token: 4242,
        character: { name: 'AliasVictim', level: 50 },
        currentLevel: 'JC_Mini2',
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        playerSpawned: true,
        send: () => {},
        sendBitBuffer: () => {}
    };
}

function testOwnBodyIdSurvivesAStrayAlias(): void {
    const client = makeClient(31140);
    // Exactly the corruption that caused it: something recorded an alias keyed on the player's
    // own body id. Whatever put it there, resolution must not act on it.
    client.entityIdAliases.set(31140, 920001);

    assert.equal(
        EntityHandler.resolveEntityAlias(client as never, 31140),
        920001,
        'the raw alias resolver still follows the map -- the guard belongs one level up'
    );
    assert.equal(
        CombatHandler.resolveCombatEntityIdForClient(client as never, 'JC_Mini2#alias', 31140),
        31140,
        "a client's own body id must come back unchanged so the attacker stays recognisable"
    );
}

function testOtherIdsStillResolveThroughTheAlias(): void {
    const client = makeClient(31140);
    // A hostile the client knows under a local id, aliased onto the canonical. This is the case
    // the resolver exists for and it must keep working.
    client.entityIdAliases.set(6342925, 920001);

    assert.equal(
        CombatHandler.resolveCombatEntityIdForClient(client as never, 'JC_Mini2#alias', 6342925),
        920001,
        'an id that is not the client\'s own body must still resolve to its canonical'
    );
}

function testZeroAndUnknownIdsAreLeftAlone(): void {
    const client = makeClient(31140);
    assert.equal(
        CombatHandler.resolveCombatEntityIdForClient(client as never, 'JC_Mini2#alias', 55555),
        55555,
        'an id with no alias and no canonical resolves to itself'
    );
}

// The writer refuses the same key, so the corruption cannot be recorded in the first place.
function testRememberEntityAliasRefusesOwnBodyKey(): void {
    const client = makeClient(31140);
    EntityHandler.rememberEntityAlias(client as never, 31140, 920001);
    assert.equal(
        client.entityIdAliases.has(31140),
        false,
        'a session own body id must never become an alias key'
    );

    EntityHandler.rememberEntityAlias(client as never, 6342925, 920001);
    assert.equal(
        client.entityIdAliases.get(6342925),
        920001,
        'an ordinary local-to-canonical alias must still be recorded'
    );
}

function main(): void {
    testOwnBodyIdSurvivesAStrayAlias();
    testOtherIdsStillResolveThroughTheAlias();
    testZeroAndUnknownIdsAreLeftAlone();
    testRememberEntityAliasRefusesOwnBodyKey();
    console.log('own_body_id_never_aliased_regression: ok');
}

main();
