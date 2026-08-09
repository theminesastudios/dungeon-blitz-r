import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { StaticServer } from '../core/StaticServer';
import { LevelHandler } from '../handlers/LevelHandler';

async function waitForListening(staticServer: StaticServer): Promise<number> {
    const httpServer = (staticServer as any).server;
    assert.ok(httpServer, 'static server should expose an http server after start');
    if (httpServer.listening) {
        return Number(httpServer.address().port);
    }

    return await new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.once('listening', () => resolve(Number(httpServer.address().port)));
    });
}

// Code scanning alerts #4/#8/#10-#16: the auth routes ran unmetered, so password
// reset and the Discord OAuth state/code parameters were free to brute force.
async function testAuthRoutesAreRateLimited(): Promise<void> {
    const staticServer = new StaticServer(0);
    staticServer.start();

    try {
        const port = await waitForListening(staticServer);
        const statuses: number[] = [];
        for (let i = 0; i < 40; i += 1) {
            const response = await fetch(`http://127.0.0.1:${port}/lostpw`);
            statuses.push(response.status);
            if (response.status === 429) {
                break;
            }
        }

        assert.ok(
            statuses.includes(429),
            `GET /lostpw should start refusing inside the auth budget, saw ${statuses.join(',')}`
        );
        assert.ok(
            statuses.filter((status) => status === 200).length >= 25,
            'the auth budget should leave room for a handful of honest retries'
        );
    } finally {
        await staticServer.stop();
    }
}

// Code scanning alert #45: a single strip pass let a split tag survive, because
// removing the inner match re-joined the leftovers into a fresh one.
function testGoblinRiverDialogueStripsNestedTags(): void {
    const normalize = (text: string): string =>
        (LevelHandler as any).normalizeGoblinRiverDialogue(text);

    assert.equal(normalize('<Cheer>Woo hoo!'), 'Woo hoo!');
    assert.equal(normalize('^tNow what was that PASSWORD?'), 'Now what was that PASSWORD?');
    assert.equal(normalize('<<Goto Red 21>>open'), 'open');
    assert.equal(normalize('<scr<Cheer>ipt>hi'), 'hi');
    assert.equal(normalize('plain line'), 'plain line');
}

async function main(): Promise<void> {
    testGoblinRiverDialogueStripsNestedTags();
    await testAuthRoutesAreRateLimited();
    console.log('security_hardening_regression: ok');
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
