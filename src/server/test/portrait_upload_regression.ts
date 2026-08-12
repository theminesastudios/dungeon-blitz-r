import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../core/config';
import { GlobalState } from '../core/GlobalState';
import { PresenceService } from '../core/PresenceService';
import { storeCharacterPortrait } from '../core/StaticServer';

// A 1x1 transparent PNG. Only the 8-byte magic actually matters to the upload guard.
const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478' +
        '9c6360000002000154a24f5e0000000049454e44ae426082',
    'hex'
);

const PORTRAITS_DIR = path.join(Config.DATA_DIR, 'portraits');

function fakeSession(name: string, address: string): any {
    return {
        character: { name },
        socket: { remoteAddress: address, destroyed: false, readyState: 'open' }
    };
}

function withSession(name: string, address: string, run: () => void): void {
    const key = name.trim().toLowerCase();
    const previous = GlobalState.sessionsByCharacterName.get(key);
    GlobalState.sessionsByCharacterName.set(key, fakeSession(name, address));
    try {
        run();
    } finally {
        if (previous) {
            GlobalState.sessionsByCharacterName.set(key, previous);
        } else {
            GlobalState.sessionsByCharacterName.delete(key);
        }
    }
}

// An offline character must never get a portrait written for it, or anyone could overwrite
// any player's public Discord portrait by POSTing their name.
(function rejectsOfflineCharacter(): void {
    const result = storeCharacterPortrait('Ghost', PNG, '10.0.0.1');
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'bad-name');
})();

// The uploader claims the name in the query string, so it only counts from that character's
// own live game connection.
(function rejectsForeignAddress(): void {
    withSession('Hero', '10.0.0.1', () => {
        const result = storeCharacterPortrait('Hero', PNG, '10.0.0.99');
        assert.equal(result.ok, false);
        assert.equal((result as { reason: string }).reason, 'not-online');
    });
})();

(function rejectsNonPngBody(): void {
    withSession('Hero', '10.0.0.1', () => {
        const result = storeCharacterPortrait('Hero', Buffer.from('<html>nope</html>'), '10.0.0.1');
        assert.equal(result.ok, false);
        assert.equal((result as { reason: string }).reason, 'not-png');
    });
})();

// Character names reach the filesystem as <name>.png, so anything outside [a-z0-9_-] is refused
// rather than sanitised into a surprising path.
(function rejectsPathTraversalName(): void {
    withSession('../../etc/passwd', '10.0.0.1', () => {
        const result = storeCharacterPortrait('../../etc/passwd', PNG, '10.0.0.1');
        assert.equal(result.ok, false);
        assert.equal((result as { reason: string }).reason, 'bad-name');
    });
})();

// IPv4-mapped IPv6 is what a dual-stack listener reports for a plain IPv4 client, so the two
// spellings of the same address have to compare equal or every upload would be rejected.
(function acceptsMappedIpv6Address(): void {
    withSession('Hero', '::ffff:10.0.0.1', () => {
        const result = storeCharacterPortrait('Hero', PNG, '10.0.0.1');
        assert.equal(result.ok, true);
        const file = path.join(PORTRAITS_DIR, 'hero.png');
        assert.equal((result as { file: string }).file, file);
        assert.ok(fs.existsSync(file));
        assert.ok(fs.readFileSync(file).equals(PNG));
        fs.unlinkSync(file);
    });
})();

// Discord's image proxy fetches the Rich Presence largeImage itself, so the URL has to be
// publicly reachable and has to change whenever the portrait does.
(function portraitUrlForRichPresence(): void {
    const file = path.join(PORTRAITS_DIR, 'hero.png');
    fs.mkdirSync(PORTRAITS_DIR, { recursive: true });
    fs.writeFileSync(file, PNG);
    const originalBase = Config.PUBLIC_BASE_URL;

    try {
        (Config as any).PUBLIC_BASE_URL = 'https://play.example.com';
        const url = PresenceService.resolvePortraitUrl('Hero');
        assert.ok(url, 'expected a portrait URL for a public base URL');
        const mtime = Math.floor(fs.statSync(file).mtimeMs / 1000);
        assert.equal(url, `https://play.example.com/portraits/hero.png?v=${mtime}`);

        // A loopback base URL would render as a blank largeImage, so the area art must stay.
        (Config as any).PUBLIC_BASE_URL = 'http://localhost:8080';
        assert.equal(PresenceService.resolvePortraitUrl('Hero'), null);

        // No captured portrait yet -> fall back rather than link a 404.
        (Config as any).PUBLIC_BASE_URL = 'https://play.example.com';
        assert.equal(PresenceService.resolvePortraitUrl('NeverPlayed'), null);
    } finally {
        (Config as any).PUBLIC_BASE_URL = originalBase;
        fs.unlinkSync(file);
    }
})();

console.log('portrait upload regression passed');
