import { Client } from './Client';
import { LegendsInn } from './LegendsInn';

/**
 * What the things standing in Legends' Inn say - and what the player says back.
 *
 * The nine stages are borrowed dungeons, and a borrowed dungeon comes with its
 * own dialogue: the room scripts still fire the lines Wolf's End's goblins and
 * Shazari's raptors were written to shout, and the Dread Rogues that replaced
 * them were shouting them. The player was doing the same - a boss room's cutscene
 * puts words in the hero's mouth about *that* dungeon's quest, which in here is a
 * quest nobody is on. This module rewrites all of it into the one story the
 * dungeon is actually about.
 *
 * ## The story
 *
 * Telahair was a Rogue who stood at the front of his people's battles until the
 * wounds and the tiredness outlasted the war. Nephit offered him a bargain -
 * Nephit's guardians would never again cross into the land Telahair defended -
 * and Telahair, who trusted him, took it. The bargain was a trap. Nephit wanted
 * more than a border, and the spell he worked on Telahair left him something else
 * entirely: a thing that no longer knows its own people. Nephit's guardians did
 * not leave either; they spread out through nine holds instead. So the ones who
 * still have the stomach for it come to Legends' Inn to end it.
 *
 * ## The nine
 *
 * Each stage ends on one of Nephit's guardians, and each of them held a different
 * part of the bargain: the one who carried the contract, the one who witnessed it,
 * the two who held Telahair down, the captain who sold him, the smith who forged
 * the chain, the keeper of his name, his own empty armour, the warden of the
 * eighth lock and the last lock itself. `BOSS_EXCHANGES_BY_STAGE` is that
 * sequence, one entry per stage, and it is what the tour is walked for: the story
 * is told nine times over, a piece at a time, by the things guarding it.
 *
 * ## How a line is chosen
 *
 * The room's *event* is kept and only the words are replaced, which is what makes
 * this possible without touching a single room script: the level still decides
 * when a hostile - or the player - speaks, at the moment it was authored to.
 *
 * For ordinary hostiles, which line comes out is a stable hash of the speaker's
 * EntType and the line it was going to say. That gives three things at once - two
 * different mobs never say the same thing, a mob with several authored lines still
 * says several different things, and the same mob says the same thing every run,
 * so the dungeon can be learned rather than re-rolled.
 *
 * For a boss and for the player it is not a hash but a *pair*. A boss speaks one
 * half of an exchange, the session remembers which half it was, and the player's
 * next line in that stage is the other half - so the hero is answering the thing
 * in front of them rather than talking past it. A player line with no boss line
 * before it (the room scripts do open on the hero occasionally) falls back to the
 * hash, so it is still a story line and still stable.
 *
 * ## Language
 *
 * English, delivered as written. Unlike the borrowed dungeons' own dialogue these
 * lines skip `DialogueTranslationLoader` entirely - see the call site in
 * `SocialHandler.translateRoomThought`. That is not just a preference: an enemy
 * line the translator cannot match falls through to `fallbackToGeneric`, which
 * would answer one of these story beats with a canned taunt.
 */

/** Stage 1-3: nobody in here knows the whole of it yet. */
const RUMOUR_LINES: string[] = [
    "You walk the road Telahair walked. It ends the same way.",
    "He was a hero once. Ask anyone still alive who remembers.",
    "Nephit came to him with an offer. He should have run.",
    "The banners you see rotting here were his.",
    "We were his people. He does not know us now.",
    "Turn back. What waits at the end of this inn is not a man.",
    "Telahair carried our shields for twenty winters.",
    "The bargain was struck in this hold. The rot started here.",
    "Nine holds, nine locks. He is behind the last of them.",
    "They say he asked only for peace. They say Nephit smiled.",
    "You will not save him. Nobody has.",
    "He gave everything for the border. Nephit took the rest."
];

/** Stage 4-6: the bargain itself, and who profited from it. */
const BARGAIN_LINES: string[] = [
    "The terms were simple: Nephit's guardians would never cross his border.",
    "Nephit kept the letter of it. We were never sent across. We were sent here.",
    "He trusted Nephit. That was the whole of the trap.",
    "A war-weary man will sign anything for one quiet season.",
    "The wounds did what no enemy could. Then Nephit did the rest.",
    "Nephit wanted more than a border, and he wrote it in small letters.",
    "We are the guardians he bargained away. Look how far we spread.",
    "There was a spell under the ink. He never read that far.",
    "He asked for his people's safety. He did not ask for his own.",
    "Every hold you have walked is a clause in that contract.",
    "The bargain held. It simply was not the bargain he made.",
    "He signed as a Rogue. He rose as something Nephit owned."
];

/** Stage 7-9: what the spell left behind. */
const RUIN_LINES: string[] = [
    "He is close now. Do not expect him to know your face.",
    "The spell took his people from him first. Then it took him.",
    "He guards Nephit's work with the same arms he raised against it.",
    "Call his name if you like. It is not his any more.",
    "What is left of Telahair does not remember the border it died for.",
    "Nephit's guardians are only his jailers. He is the cell.",
    "He killed his own captains and did not stop to look.",
    "You are the last of the brave ones to try this. There were many.",
    "He was the shield of a country. Now he is the lock on a door.",
    "Nothing of the man is answering. Only what was put in his place.",
    "Turn back while your own name still fits you.",
    "The end of the inn is his. Nothing walks out of it."
];

/**
 * One half-turn of a boss fight's conversation.
 *
 * `boss` is what the guardian says; `player` is what the hero says back to *that*
 * line. They are written as a pair and delivered as a pair - see `rememberBossLine`
 * - because a reply that does not answer anything reads worse than no reply.
 */
interface BossExchange {
    boss: string;
    player: string;
}

/**
 * The nine guardians, in the order the road runs.
 *
 * Each stage's pool is written for the part of the bargain that guardian held, so
 * walking the tour in order tells the story from the offer to the last lock. Four
 * exchanges each: a boss room fires a handful of lines across an intro, a phase
 * change and a death, and four is enough that a stage does not repeat itself
 * inside one fight.
 */
const BOSS_EXCHANGES_BY_STAGE: Record<number, BossExchange[]> = {
    // 1 - Wolf's End. The one who carried the contract from Nephit's hand to his.
    1: [
        {
            boss: "I carried the paper. I put it in his hands myself, and he thanked me for it.",
            player: "Then you are where the rot started. I will finish here and work inwards."
        },
        {
            boss: "He read the first page twice and the rest not at all. He was so tired.",
            player: "He was tired because he held your kind off for twenty years. Say his name properly."
        },
        {
            boss: "Nephit's word: never again across that border. Look - we never crossed it.",
            player: "No. You made a home on the other side of the door instead. Move."
        },
        {
            boss: "Eight more of us stand between you and him, courier by courier.",
            player: "Then I have eight more doors to open. Start counting down."
        }
    ],
    // 2 - Blackrose Mire. The witness, who watched the signing and said nothing.
    2: [
        {
            boss: "I stood at the table. I watched the ink dry. I said nothing.",
            player: "You could have spoken. That is the whole of what I hold against you."
        },
        {
            boss: "It is not a lie if you simply let a man believe himself.",
            player: "It is here. Every one of his people paid for your silence."
        },
        {
            boss: "He looked up once, at the end, as if he had heard something under the words.",
            player: "He had. He heard you breathing. Now hear me."
        },
        {
            boss: "You will stand where he stood, and you will be as sure as he was.",
            player: "I have read the contract. He never got the chance. That is the difference."
        }
    ],
    // 3 - Bridgetown. The two who held him down while the spell was worked.
    3: [
        {
            boss: "It takes two to hold a man like that still. My brother took the left arm.",
            player: "Then I will take you both, in whatever order you would rather."
        },
        {
            boss: "He did not fight us. That is the part nobody believes.",
            player: "He did not fight because he thought he was among friends. So did I, once."
        },
        {
            boss: "The spell went in slowly. He asked us to tell his people he was well.",
            player: "I will tell them the truth instead. After."
        },
        {
            boss: "Twenty winters of shields, and it ended on a bridge with two of us holding him.",
            player: "It has not ended. That is why I am standing on your bridge."
        }
    ],
    // 4 - Cemetery Hill. Elsyn, his own captain, who took Nephit's coin.
    4: [
        {
            boss: "I rode at his right hand for eleven years. Do not look at me like that.",
            player: "I am looking at you exactly the way his people will, when I tell them."
        },
        {
            boss: "Nephit paid me in the only coin that mattered. He let me keep my name.",
            player: "You kept the sound of it. Nothing that answers to it is left."
        },
        {
            boss: "Someone had to open the gate for the courier. It may as well have been a friend.",
            player: "It could only have been a friend. That is why it worked."
        },
        {
            boss: "He will not know you either, at the end. Save yourself the walk.",
            player: "Then I will go anyway, and be the one who remembered."
        }
    ],
    // 5 - Stormshard. The smith who forged what the bargain needed.
    5: [
        {
            boss: "Paper does not hold a man like that. I made what does.",
            player: "Then I will unmake it, link by link, starting with the smith."
        },
        {
            boss: "Nine holds, nine locks, and every one of them came off my anvil.",
            player: "Good. Then you know exactly how they break."
        },
        {
            boss: "I have never seen the man. I only ever measured him.",
            player: "You measured a hero for a cage. That is worse, not better."
        },
        {
            boss: "The last lock is not iron. You will not cut that one.",
            player: "I will find out at the end of this road. Get out of the middle of it."
        }
    ],
    // 6 - Emerald Glades. The keeper of what was taken out of him.
    6: [
        {
            boss: "What Nephit took out of him had to be put somewhere. It was put here.",
            player: "Then hand it back. You can do that standing or otherwise."
        },
        {
            boss: "His name. The faces of his people. The reason he ever picked up a blade.",
            player: "I know all three. I have been carrying them since Wolf's End."
        },
        {
            boss: "Give a thing like that back and it will not fit him any more.",
            player: "Let him decide that. It was never yours to keep for him."
        },
        {
            boss: "You want to give a dead man his memory. What a cruelty that would be.",
            player: "He is not dead. That is the cruelty. Move."
        }
    ],
    // 7 - Deepgard Castle. His own armour, still walking its post.
    7: [
        {
            boss: "You know this shape. Twenty winters at the front of a shield wall.",
            player: "I know the armour. I have seen it on banners since I was a child."
        },
        {
            boss: "Nephit left the shell on the wall and told it to keep guarding.",
            player: "Then it has been guarding the wrong thing for a long time."
        },
        {
            boss: "It does not know it is empty. It thinks the border is still out there.",
            player: "The border held. Tell it that, if anything in there can hear."
        },
        {
            boss: "Strike it and you strike him. Everyone stops here.",
            player: "I am not everyone, and this is not him. Not yet."
        }
    ],
    // 8 - Shazari Desert. The warden of the eighth lock, who has been waiting.
    8: [
        {
            boss: "Eight. You have come further than any of them. I had almost stopped watching.",
            player: "Then watch properly. There is only one of you and one more after."
        },
        {
            boss: "Nephit does not know you are here. He stopped asking about the road years ago.",
            player: "Good. I would rather arrive without an audience."
        },
        {
            boss: "The last hold is not guarded the way this one is. He guards it himself.",
            player: "I know. That is the part I have been walking towards."
        },
        {
            boss: "When he does not know your face, will you still swing?",
            player: "Yes. And I will say his name while I do it."
        }
    ],
    // 9 - Valhaven. The last lock, standing in front of what is left of him.
    9: [
        {
            boss: "This is the ninth hold. Behind me is the thing that was Telahair.",
            player: "Then step aside, or be the last thing between us. Either suits me."
        },
        {
            boss: "I am not a guardian. I am the lock, and he is what turns in me.",
            player: "Then breaking you is the whole of it. Good."
        },
        {
            boss: "You have walked nine holds to give a man back a name he cannot hold.",
            player: "He held a country for twenty years. He can hold his own name."
        },
        {
            boss: "Nephit built me last, and best, and he never expected to need me.",
            player: "He was wrong about the bargain too. Let us find out how wrong."
        }
    ]
};

/**
 * What the hero says when there is no boss in front of them.
 *
 * The room scripts do not only speak the player in boss rooms - a corridor
 * cutscene, a door, a first sight of the hold - and those lines used to be
 * whatever quest the borrowed dungeon was written around. Here they are the road
 * itself: what a person walking nine holds towards this would actually say.
 */
const PLAYER_ROAD_LINES: string[] = [
    "Nine holds. Then whatever is left of him.",
    "Every one of these things knows more about the bargain than his own people do.",
    "They keep telling me he will not know my face. I will manage.",
    "Twenty winters at the front, and this is the thanks the ledger shows.",
    "Nephit never crossed the border. He just moved the war indoors.",
    "Someone should have read the small letters. Somebody is about to.",
    "Keep moving. Standing still in here is how you start believing them.",
    "If any of his people made it this far before me, they did not make it back.",
    "I am not here to save a legend. I am here to end a contract.",
    "One more hold. Then the next. That is the whole plan.",
    "They spread through nine holds so nobody could burn it out at once.",
    "He asked for peace for his people. I will settle that debt for him."
];

/** Which pool a stage's ordinary hostiles draw from. */
function poolForStage(stage: number): string[] {
    if (stage <= 3) return RUMOUR_LINES;
    if (stage <= 6) return BARGAIN_LINES;
    return RUIN_LINES;
}

/** The exchanges for a stage, falling back to the last hold's if one is missing. */
function exchangesForStage(stage: number): BossExchange[] {
    return BOSS_EXCHANGES_BY_STAGE[stage] ?? BOSS_EXCHANGES_BY_STAGE[9];
}

/**
 * A stable, well-spread index for a pair of strings.
 *
 * FNV-1a rather than anything cleverer: it only has to be deterministic across
 * restarts and to scatter neighbouring inputs, and two EntTypes in one stage
 * usually differ only in a trailing digit.
 */
function hashIndex(...parts: string[]): number {
    let hash = 0x811c9dc5;
    for (const part of parts) {
        for (let index = 0; index < part.length; index += 1) {
            hash ^= part.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        hash = Math.imul(hash ^ 0x5f, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function normalizeName(value: unknown): string {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The EntType a speaking entity is, as this session knows it. */
function speakerName(client: Client, entityId: number): string {
    const entity = client.entities?.get(entityId) as Record<string, unknown> | undefined;
    return String(entity?.name ?? entity?.EntName ?? entity?.entName ?? '').trim();
}

/**
 * The exchange each session last heard a boss speak, so the player's next line
 * can answer it.
 *
 * On the session rather than in a map keyed by token, so it cannot outlive the
 * connection, and stamped with the level so a reply cannot follow a player through
 * a portal and answer the previous hold's guardian.
 */
interface DialogueMemory {
    levelName: string;
    index: number;
}

const lastBossExchange: WeakMap<object, DialogueMemory> = new WeakMap();

function rememberBossLine(client: Client, levelName: string, index: number): void {
    lastBossExchange.set(client as unknown as object, { levelName, index });
}

function recallBossLine(client: Client, levelName: string): number | null {
    const memory = lastBossExchange.get(client as unknown as object);
    return memory && memory.levelName === levelName ? memory.index : null;
}

export class LegendsInnDialogue {
    /**
     * The line a Legends' Inn speaker should say instead of the one its room
     * script asked for, or null if this is not a line to rewrite.
     *
     * Three kinds of speaker are answered here, and only outside a Legends' Inn
     * stage does this return null:
     *
     *   - **the player**, who used to repeat whatever quest the borrowed dungeon
     *     was written around, and now answers the guardian in front of them;
     *   - **a stage boss**, who speaks its own hold's half of the story;
     *   - **everything else hostile**, from the stage's rumour/bargain/ruin pool.
     *
     * Anything the session cannot name at all is left alone, because a line with
     * no speaker cannot be given a speaker's voice.
     */
    static resolveLine(client: Client, entityId: number, authoredText: string): string | null {
        const stageInfo = LegendsInn.getStage(client?.currentLevel);
        if (!stageInfo) {
            return null;
        }

        const stage = Math.max(1, Math.round(Number(stageInfo.stage) || 1));
        const entity = client.entities?.get(entityId) as Record<string, unknown> | undefined;
        const exchanges = exchangesForStage(stage);

        // The player's own bubble. `clientEntID` is checked as well as `isPlayer`
        // because a cutscene line is sent for the hero's entity at a point where
        // the session's own copy of it is not always the thing being spoken for.
        if (entity?.isPlayer || (client.clientEntID > 0 && entityId === client.clientEntID)) {
            const heard = recallBossLine(client, stageInfo.levelName);
            if (heard !== null) {
                return exchanges[heard % exchanges.length].player;
            }
            // Nothing to answer yet: the room opened on the hero. A line about the
            // road rather than about a guardian who has not spoken.
            const index = hashIndex(stageInfo.levelName, String(authoredText ?? ''));
            return PLAYER_ROAD_LINES[index % PLAYER_ROAD_LINES.length];
        }

        const name = speakerName(client, entityId);
        if (!name) {
            return null;
        }

        if (stageInfo.bosses.some((boss) => normalizeName(boss) === normalizeName(name))) {
            const index = hashIndex(stageInfo.levelName, name, String(authoredText ?? '')) % exchanges.length;
            rememberBossLine(client, stageInfo.levelName, index);
            return exchanges[index].boss;
        }

        const pool = poolForStage(stage);
        // The stage is part of the key so the same EntType, reused two stages
        // apart, does not repeat itself word for word.
        const index = hashIndex(stageInfo.levelName, name, String(authoredText ?? ''));
        return pool[index % pool.length];
    }

    /** Every line this module can produce, for the translation tooling. */
    static getAllLines(): string[] {
        const exchanges = Object.values(BOSS_EXCHANGES_BY_STAGE).flat();
        return [
            ...RUMOUR_LINES,
            ...BARGAIN_LINES,
            ...RUIN_LINES,
            ...PLAYER_ROAD_LINES,
            ...exchanges.map((exchange) => exchange.boss),
            ...exchanges.map((exchange) => exchange.player)
        ];
    }
}
