const fs = require('fs');
const path = require('path');

/**
 * Pull the dungeon-sync diagnostic lines out of the dev logs, into one small file.
 *
 * `runDevServer.js` already mirrors every session into `logs/dev-<timestamp>.log`, but nodemon
 * opens a new one on every restart, so a single play session ends up spread across a handful of
 * files and buried in startup noise. This walks the recent ones in order and keeps only the
 * lines that say something about a shared dungeon run.
 *
 * Usage:
 *   npm run log:dungeon            # last 20 minutes
 *   npm run log:dungeon -- 60      # last 60 minutes
 *   npm run log:dungeon -- 60 all  # every line, not just the diagnostic tags
 */

const TAGS = [
    '[ClientObject]',
    '[RewardSource]',
    '[HostileAttach]',
    '[HostileHit]',
    '[HostileHpReport]',
    '[HostileSnapshot]',
    '[EnemyDeath]',
    '[EnemyDestroy]',
    '[HostileUntouchedDamage]',
    '[HostileDeathAccepted]',
    '[HostileRetire]',
    '[ChestCanonical]',
    '[ChestClaim]',
    '[HostileDeathRejected]',
    '[HostileDeathRefused]',
    'defeatRegistered',
    '[DungeonBonusLevels]',
    '[Chest]',
    '[DungeonDifficulty]',
    'Carried the',
    'Cleared finished dungeon run scope',
    'entering JC_',
    'Initializing',
    '[dev-crash]'
];

const logDir = path.resolve(__dirname, '..', 'logs');
const minutes = Math.max(1, Number(process.argv[2]) || 20);
const keepEverything = String(process.argv[3] ?? '').toLowerCase() === 'all';
const outPath = path.join(logDir, 'dungeon-diagnostic.txt');

if (!fs.existsSync(logDir)) {
    console.error(`No log directory at ${logDir}. Start the server with "npm run dev" first.`);
    process.exit(1);
}

const cutoff = Date.now() - (minutes * 60 * 1000);
const files = fs.readdirSync(logDir)
    .filter((name) => name.startsWith('dev-') && name.endsWith('.log'))
    .map((name) => {
        const filePath = path.join(logDir, name);
        return { name, filePath, mtime: fs.statSync(filePath).mtimeMs };
    })
    .filter((entry) => entry.mtime >= cutoff)
    .sort((a, b) => a.mtime - b.mtime);

if (files.length === 0) {
    console.error(
        `No dev log written in the last ${minutes} minute(s).\n\n` +
        'The usual cause is that the log files were deleted while the server was running.\n' +
        'runDevServer opens its log file once at startup and writes to that handle; delete the\n' +
        'file underneath it and every later line goes nowhere, with no new file created. The\n' +
        'server keeps running and its console output is unaffected -- only the file is lost.\n\n' +
        'Restart the server and the next session writes a fresh log.\n' +
        'Otherwise the server may not be running through "npm run dev", or the window is too\n' +
        'short: npm run log:dungeon -- 120'
    );
    process.exit(1);
}

const kept = [];
for (const file of files) {
    const lines = fs.readFileSync(file.filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        if (keepEverything || TAGS.some((tag) => line.includes(tag))) {
            kept.push(line);
        }
    }
}

// A long window over old logs can run to millions of lines -- the pre-latch death storm alone
// left 100k of them. Keep the most recent slice, which is the play session being asked about.
const MAX_LINES = 20000;
const trimmed = kept.length > MAX_LINES ? kept.slice(-MAX_LINES) : kept;
fs.writeFileSync(outPath, `${trimmed.join('\n')}\n`, 'utf8');

console.log(`Read ${files.length} log file(s) from the last ${minutes} minute(s).`);
console.log(
    `Kept ${trimmed.length} line(s)` +
    (kept.length > trimmed.length ? ` (trimmed from ${kept.length}; use a shorter window)` : '') +
    ` -> ${outPath}\n`
);

// The counts are usually the answer on their own: whether hits reach the server at all, how
// many enemies the run actually buried, and whether anything reset or re-keyed the scope.
const counts = new Map();
for (const line of trimmed) {
    for (const tag of TAGS) {
        if (line.includes(tag)) {
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
            break;
        }
    }
}
console.log('Summary:');
for (const tag of TAGS) {
    const count = counts.get(tag) ?? 0;
    if (count > 0) {
        console.log(`  ${String(count).padStart(6)}  ${tag}`);
    }
}
if (!counts.get('[HostileHit]')) {
    console.log(
        '\n  NOTE: not one [HostileHit] line. No damage reached a canonical hostile in this\n' +
        '  window -- either nobody fought, or the client is killing its own copies without\n' +
        '  telling the server.'
    );
}

// The one question a joined run turns on: are both members playing the SAME run?
//
// `[HostileSnapshot]` already carries the answer -- the scope key it is reported under, and
// each member's bound-enemy count -- but it is one line among thousands and easy to walk past.
// Two different `Level#instance` keys for one level means two runs: the joiner's enemies were
// never bound to the run's roster, so they spawn from scratch, their kills go nowhere, and the
// progress bars cannot agree no matter what the sharing code does.
const snapshots = trimmed.filter((line) => line.includes('[HostileSnapshot]'));
if (snapshots.length > 0) {
    const byScope = new Map();
    for (const line of snapshots) {
        const scope = (line.match(/([A-Za-z0-9_]+#[^\s]+)/) || [])[1];
        if (scope) {
            byScope.set(scope, line);
        }
    }

    console.log('\nRuns seen:');
    for (const [scope, line] of byScope) {
        const detail = line.slice(line.indexOf('[HostileSnapshot]'));
        console.log(`  ${scope}\n    ${detail}`);
    }

    // Judge the LATEST run only. Several scopes in one capture is normal -- every server
    // restart opens a new one -- and comparing across them says nothing about whether two
    // players were together at any single moment.
    const latest = snapshots[snapshots.length - 1];
    const latestScope = (latest.match(/([A-Za-z0-9_]+#[^\s]+)/) || [])[1] || '?';
    const members = Array.from(latest.matchAll(/([A-Za-z][A-Za-z0-9_]*):(\d+)\/(\d+)/g))
        .map((match) => ({ name: match[1], bound: Number(match[2]), total: Number(match[3]) }));

    console.log(`\n  Latest run: ${latestScope}`);
    if (latest.includes('PARTY-MEMBER-ALONE-IN-THIS-SCOPE')) {
        console.log(
            '  VERDICT: a party member was alone in this run. Their mate never arrived in it, so\n' +
            '  nothing can be shared: enemies spawn fresh, kills register for nobody, and the\n' +
            '  progress bars cannot meet.'
        );
    } else if (members.length < 2) {
        console.log('  VERDICT: only one member was in this run, so there is nothing to compare.');
    } else if (members.some((member) => member.bound < member.total)) {
        console.log(
            '  VERDICT: both members are in one run, but at least one enemy is bound to nobody\n' +
            `  (${members.map((member) => `${member.name} ${member.bound}/${member.total}`).join(', ')}).\n` +
            '  The server cannot address that enemy on any screen, so it can neither kill it nor\n' +
            '  take it away.'
        );
    } else {
        console.log(
            '  VERDICT: both members in one run, every enemy bound on both screens. Sharing and\n' +
            '  binding are sound -- look at the kill path, not at the delivery.'
        );
    }
}

// How each member's copies arrived. A joiner walking into a run that has already cleared a room
// should be attaching a pile of DEAD ones -- those get killed on arrival. All-alive means the
// run's deaths are not on the roster this joiner is binding to.
const attaches = trimmed.filter((line) => line.includes('[HostileAttach]'));
if (attaches.length > 0) {
    const perPlayer = new Map();
    for (const line of attaches) {
        const who = (line.match(/->\s*([^:]+):/) || [])[1];
        const dead = /dead=true/.test(line);
        const promoted = /matched=promoted/.test(line);
        if (!who) continue;
        const row = perPlayer.get(who) ?? { dead: 0, alive: 0, promoted: 0 };
        if (dead) row.dead += 1; else row.alive += 1;
        if (promoted) row.promoted += 1;
        perPlayer.set(who, row);
    }
    console.log('\nHostiles attached (how each member\'s copies arrived):');
    for (const [who, row] of perPlayer) {
        console.log(
            `  ${who.padEnd(14)} alive=${String(row.alive).padStart(3)} dead=${String(row.dead).padStart(3)}` +
            (row.promoted ? `  (${row.promoted} had no canonical to bind to)` : '')
        );
    }
}

console.log('\nLast lines:\n');
for (const line of trimmed.slice(-120)) {
    console.log(line);
}
