/// <reference types="node" />

import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { RewardHandler } from '../handlers/RewardHandler';

// Reported live: "XP in the overworld is shared regardless if you're in a party or not."
//
// Combat contributions are keyed `levelScope:entityId:nonce`, and an overworld scope is
// the bare level name -- there is no instance id, because everyone standing in NewbieRoad
// belongs to one scope. Overworld hostiles are private client spawns, so each player's own
// client invents their entity ids, and two players' local ids collide constantly. Both then
// register as contributors to what the server reads as one entity, and resolveEligibleRecipients
// handed the kill to both strangers.
const OVERWORLD_LEVEL = 'NewbieRoad';
const COLLIDING_ENTITY_ID = 5000;

type FakeClient = {
    token: number;
    character: { name: string } | null;
    currentLevel: string;
    levelInstanceId: string;
    playerSpawned: boolean;
};

function createClient(name: string, token: number): FakeClient {
    return {
        token,
        character: { name },
        currentLevel: OVERWORLD_LEVEL,
        levelInstanceId: '',
        playerSpawned: true
    };
}

function recipientNames(client: FakeClient): string[] {
    const { recipients } = (RewardHandler as any).resolveEligibleRecipients(client, COLLIDING_ENTITY_ID);
    return recipients.map((recipient: FakeClient) => String(recipient.character?.name ?? '')).sort();
}

// Both players hit "entity 5000" -- their own private copy of it, but the server sees one key.
function seedCollidingContributions(...names: string[]): void {
    GlobalState.combatContributions.set(
        `${OVERWORLD_LEVEL}:${COLLIDING_ENTITY_ID}:0`,
        new Map(names.map((name) => [name.toLowerCase(), 100]))
    );
}

function withParty(partyId: number, leader: string, members: string[], run: () => void): void {
    GlobalState.partyGroups.set(partyId, { id: partyId, leader, members, locked: false } as never);
    for (const member of members) {
        GlobalState.partyByMember.set(member.toLowerCase(), partyId);
    }
    try {
        run();
    } finally {
        GlobalState.partyGroups.delete(partyId);
        for (const member of members) {
            GlobalState.partyByMember.delete(member.toLowerCase());
        }
    }
}

function testStrangersDoNotSplitAnOverworldKill(): void {
    const alex = createClient('AlexMercer', 21950);
    const stranger = createClient('Neodevils', 33485);
    GlobalState.sessionsByToken.set(alex.token, alex as never);
    GlobalState.sessionsByToken.set(stranger.token, stranger as never);
    seedCollidingContributions('AlexMercer', 'Neodevils');

    assert.deepEqual(
        recipientNames(alex),
        ['AlexMercer'],
        'an unpartied stranger was granted the reward for a colliding overworld entity id'
    );
    assert.deepEqual(
        recipientNames(stranger),
        ['Neodevils'],
        'the reward leaked in the other direction too'
    );
}

// The party case is the whole point of contribution tracking and must not regress.
function testPartyStillSharesTheKill(): void {
    const alex = createClient('AlexMercer', 21950);
    const mate = createClient('Neodevils', 33485);
    GlobalState.sessionsByToken.set(alex.token, alex as never);
    GlobalState.sessionsByToken.set(mate.token, mate as never);
    seedCollidingContributions('AlexMercer', 'Neodevils');

    withParty(8101, 'AlexMercer', ['AlexMercer', 'Neodevils'], () => {
        assert.deepEqual(
            recipientNames(alex),
            ['AlexMercer', 'Neodevils'],
            'a party stopped sharing an overworld kill'
        );
    });
}

// A party member who never touched it still shares, which is what addContributorRecipients
// is for -- the filter must not cost that.
function testPartyMemberWhoDidNotHitItStillShares(): void {
    const alex = createClient('AlexMercer', 21950);
    const mate = createClient('Neodevils', 33485);
    GlobalState.sessionsByToken.set(alex.token, alex as never);
    GlobalState.sessionsByToken.set(mate.token, mate as never);
    seedCollidingContributions('AlexMercer');

    withParty(8101, 'AlexMercer', ['AlexMercer', 'Neodevils'], () => {
        assert.deepEqual(
            recipientNames(alex),
            ['AlexMercer', 'Neodevils'],
            'a party member who did not land a hit stopped sharing the kill'
        );
    });
}

function run(): void {
    const savedSessions = new Map(GlobalState.sessionsByToken);
    const savedContributions = new Map(GlobalState.combatContributions);
    GlobalState.sessionsByToken.clear();
    GlobalState.combatContributions.clear();

    try {
        testStrangersDoNotSplitAnOverworldKill();
        GlobalState.sessionsByToken.clear();
        GlobalState.combatContributions.clear();
        testPartyStillSharesTheKill();
        GlobalState.sessionsByToken.clear();
        GlobalState.combatContributions.clear();
        testPartyMemberWhoDidNotHitItStillShares();
    } finally {
        GlobalState.sessionsByToken.clear();
        for (const [token, session] of savedSessions) {
            GlobalState.sessionsByToken.set(token, session);
        }
        GlobalState.combatContributions.clear();
        for (const [key, value] of savedContributions) {
            GlobalState.combatContributions.set(key, value);
        }
    }

    console.log('overworld_xp_party_scope_regression: ok');
}

run();
