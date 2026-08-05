#!/usr/bin/env node

/**
 * Adds a "Default Dyes" button to the dye screen, directly above "Apply Dyes".
 *
 * Two SWFs are involved:
 *
 *   UI_1.swf         - the artwork. A clone of the Apply button symbol (char 1719 and the
 *                      two sprites it nests) is added with the label "Default Dyes", then
 *                      placed inside a_DyeWindow (char 1734) as `am_Default`, one button
 *                      height above `am_Apply`. Building the button on the timeline is the
 *                      whole point: earlier attempts that created the button at runtime
 *                      (new MovieClip / .constructor + addChild) froze the screen.
 *
 *   DungeonBlitz.swf - class_121 (Game.screenDyeGear). Three P-code injections:
 *                        * OnCreateScreen wires am_Default to OnApplyDyes, exactly like
 *                          am_Apply is wired.
 *                        * OnApplyDyes, when the click came from am_Default, *stages* the
 *                          reset instead of sending it: every gear slot's pending dye pair
 *                          becomes `new class_21()`, whose dye id is 0, then Refresh() runs
 *                          and the handler returns. Shirt and pants (var_202 / var_204) are
 *                          deliberately left alone.
 *                        * method_536 hides the slot's bottle icon for a dye id of 0, so a
 *                          staged reset reads as "no dye" rather than as a black dye.
 *
 * Staging a real class_21 rather than a null is what makes the rest work for free: the
 * existing machinery already treats a non-null pending dye as a change, so method_1571
 * counts it, prices it and enables Apply Dyes; GetPaperDollType emits id 0 and the preview
 * shows the undyed gear; and OnApplyDyes writes the per-slot "has data" bit plus a 0.
 * A null pending dye would have done none of that - it is indistinguishable from "nothing
 * pending", and the packet would omit the slot entirely.
 *
 * Server side, CharacterHandler.handleApplyDyes counts a cleared dye as a changed unit so
 * its price matches the one the client showed.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_UI_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'UI_1.swf');
const DEFAULT_GAME_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const INDEX_HTML = path.join('src', 'client', 'content', 'localhost', 'index.html');

// --- UI_1.swf ---------------------------------------------------------------
const SRC_TEXT_ID = 1716;      // DefineEditText holding "Apply Dyes"
const SRC_INNER_ID = 1717;     // sprite that draws the button face + that text
const SRC_BUTTON_ID = 1719;    // 4-frame button sprite (Ready/Over/Click/Inactive)
const DYE_WINDOW_ID = 1734;    // a_DyeWindow
const NEW_TEXT_ID = 2801;
const NEW_INNER_ID = 2802;
const NEW_BUTTON_ID = 2803;
const NEW_DEPTH = 3245;
const BUTTON_LABEL = 'Default Dyes';
const INSTANCE_NAME = 'am_Default';
const Y_OFFSET_TWIPS = -620;   // the button is 0.8-scaled (~21 px tall), so this leaves a ~10 px gap

// --- DungeonBlitz.swf -------------------------------------------------------
// class_121's method bodies are numbered in trait order, so one known anchor gives all of
// them. `-replace` wants that body index; patchGameSwf asserts the anchor still holds.
const FIRST_TRAIT_BODY = 2175;      // the body index of class_121's first trait, OnCreateScreen
const NS_SET = '[PrivateNamespace("*","11"),PackageNamespace(""),PrivateNamespace("*","32"),PackageInternalNs(""),'
    + 'Namespace("http://adobe.com/AS3/2006/builtin"),ProtectedNamespace("_-ut"),StaticProtectedNs("_-ut"),'
    + 'StaticProtectedNs("_-3X")]';
const AM_DEFAULT = `Multiname("${INSTANCE_NAME}",${NS_SET})`;
const ML = `MultinameL(${NS_SET})`;
const VAR_75 = 'QName(PrivateNamespace("*","11"),"var_75")';
const CLASS_21 = 'QName(PackageNamespace(""),"class_21")';
const VAR_972 = 'QName(PrivateNamespace("*","11"),"var_972")';

function parseArgs(argv) {
    const args = { uiSwf: DEFAULT_UI_SWF, gameSwf: DEFAULT_GAME_SWF, ffdec: '', verify: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--ui-swf') args.uiSwf = argv[++i] || '';
        else if (arg === '--swf') args.gameSwf = argv[++i] || '';
        else if (arg === '--ffdec' || arg === '-f') args.ffdec = argv[++i] || '';
        else if (arg === '--verify') args.verify = true;
        else if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-dye-default-button.js [--verify]',
                '    [--ui-swf <UI_1.swf>] [--swf <DungeonBlitz.swf>] [--ffdec <path>]',
                '',
                'Adds a "Default Dyes" button above "Apply Dyes" that reverts equipped gear to its',
                'undyed colours, free of charge.'
            ].join('\n'));
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function detectFfdec(explicitPath) {
    const candidates = [
        explicitPath,
        'C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe',
        path.join(REPO_ROOT, 'build', 'ffdec', 'ffdec.jar'),
        path.join(REPO_ROOT, 'build', 'tools', 'ffdec_26.0.0', 'ffdec.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh'
    ].filter(Boolean);
    return candidates.find((c) => fs.existsSync(path.resolve(c))) || '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const ffdecHome = path.join(REPO_ROOT, 'build', 'ffdec-home');
    fs.mkdirSync(path.join(ffdecHome, 'LocalAppData'), { recursive: true });
    const env = {
        ...process.env,
        APPDATA: ffdecHome,
        HOME: ffdecHome,
        LOCALAPPDATA: path.join(ffdecHome, 'LocalAppData'),
        USERPROFILE: ffdecHome
    };
    if (resolved.endsWith('.jar')) {
        execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], { env, stdio: 'pipe' });
        return;
    }
    execFileSync(resolved, args, { env, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// SWF tag plumbing
// ---------------------------------------------------------------------------

function loadSwf(file) {
    const raw = fs.readFileSync(file);
    const sig = raw.toString('latin1', 0, 3);
    if (sig === 'FWS') return { sig, header: raw.slice(0, 8), body: raw.slice(8) };
    if (sig === 'CWS') return { sig, header: raw.slice(0, 8), body: zlib.inflateSync(raw.slice(8)) };
    throw new Error(`Unsupported SWF signature ${sig} in ${file}`);
}

function saveSwf(file, swf, body) {
    const header = Buffer.from(swf.header);
    header.writeUInt32LE(body.length + 8, 4);
    const payload = swf.sig === 'CWS' ? zlib.deflateSync(body, { level: 9 }) : body;
    fs.writeFileSync(file, Buffer.concat([header, payload]));
}

function rectByteLen(buf, offset) {
    return Math.ceil((5 + (buf[offset] >> 3) * 4) / 8);
}

function parseTags(buf, start, end) {
    const out = [];
    let off = start;
    while (off < end - 1) {
        const th = buf.readUInt16LE(off);
        const code = th >> 6;
        let len = th & 0x3f;
        let hl = 2;
        if (len === 0x3f) { len = buf.readUInt32LE(off + 2); hl = 6; }
        out.push({ code, len, hl, start: off, dataStart: off + hl, end: off + hl + len });
        off += hl + len;
        if (code === 0) break;
    }
    return out;
}

function makeTag(code, data) {
    if (data.length < 0x3f) {
        const h = Buffer.alloc(2);
        h.writeUInt16LE((code << 6) | data.length, 0);
        return Buffer.concat([h, data]);
    }
    const h = Buffer.alloc(6);
    h.writeUInt16LE((code << 6) | 0x3f, 0);
    h.writeUInt32LE(data.length, 2);
    return Buffer.concat([h, data]);
}

class BitReader {
    constructor(buf, offset) { this.b = buf; this.o = offset; this.bit = 0; }
    u(n) {
        let v = 0;
        for (let i = 0; i < n; i += 1) {
            const byte = this.b[this.o + (this.bit >> 3)];
            v = (v << 1) | ((byte >> (7 - (this.bit & 7))) & 1);
            this.bit += 1;
        }
        return v >>> 0;
    }
    s(n) { let v = this.u(n); if (n && (v & (1 << (n - 1)))) v -= (1 << n); return v; }
}

class BitWriter {
    constructor() { this.bits = []; }
    u(v, n) { for (let i = n - 1; i >= 0; i -= 1) this.bits.push((v >> i) & 1); }
    s(v, n) { this.u(v < 0 ? v + (1 << n) : v, n); }
    bytes() {
        const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
        this.bits.forEach((bit, i) => { if (bit) out[i >> 3] |= 1 << (7 - (i & 7)); });
        return out;
    }
}

function signedBits(v) { let n = 1; while (v < -(1 << (n - 1)) || v > (1 << (n - 1)) - 1) n += 1; return n + 1; }

function decodeMatrix(buf, offset) {
    const br = new BitReader(buf, offset);
    const m = { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0, hasScale: false, hasRotate: false };
    m.hasScale = Boolean(br.u(1));
    if (m.hasScale) { const nb = br.u(5); m.sx = br.s(nb); m.sy = br.s(nb); }
    m.hasRotate = Boolean(br.u(1));
    if (m.hasRotate) { const nb = br.u(5); m.r0 = br.s(nb); m.r1 = br.s(nb); }
    const nb = br.u(5); m.tx = br.s(nb); m.ty = br.s(nb);
    return m;
}

function encodeMatrix(m) {
    const bw = new BitWriter();
    if (m.hasScale) {
        const nb = Math.max(signedBits(m.sx), signedBits(m.sy));
        bw.u(1, 1); bw.u(nb, 5); bw.s(m.sx, nb); bw.s(m.sy, nb);
    } else bw.u(0, 1);
    if (m.hasRotate) {
        const nb = Math.max(signedBits(m.r0), signedBits(m.r1));
        bw.u(1, 1); bw.u(nb, 5); bw.s(m.r0, nb); bw.s(m.r1, nb);
    } else bw.u(0, 1);
    const nb = Math.max(signedBits(m.tx), signedBits(m.ty));
    bw.u(nb, 5); bw.s(m.tx, nb); bw.s(m.ty, nb);
    return bw.bytes();
}

// ---------------------------------------------------------------------------
// UI_1.swf
// ---------------------------------------------------------------------------

function uiHasDefaultButton(swf) {
    const body = swf.body;
    const tags = parseTags(body, rectByteLen(body, 0) + 4, body.length);
    return tags.some((t) => [37, 39].includes(t.code) && body.readUInt16LE(t.dataStart) === NEW_BUTTON_ID);
}

function patchUiSwf(swf) {
    const body = swf.body;
    const tags = parseTags(body, rectByteLen(body, 0) + 4, body.length);
    const findDef = (code, id) => {
        const t = tags.find((x) => x.code === code && body.readUInt16LE(x.dataStart) === id);
        if (!t) throw new Error(`UI_1.swf: tag code ${code} id ${id} not found`);
        return t;
    };
    const tText = findDef(37, SRC_TEXT_ID);
    const tInner = findDef(39, SRC_INNER_ID);
    const tButton = findDef(39, SRC_BUTTON_ID);
    const tWindow = findDef(39, DYE_WINDOW_ID);

    // DefineEditText clone carrying the new label.
    const d = body.slice(tText.dataStart, tText.end);
    let o = 2 + rectByteLen(d, 2);
    const flags = d.readUInt16BE(o); o += 2;
    if (flags & 0x0100) o += 4;                              // font id + height
    if (flags & 0x0080) { while (d[o] !== 0) o += 1; o += 1; } // font class
    if (flags & 0x0400) o += 4;                              // text colour
    if (flags & 0x0200) o += 2;                              // max length
    if (flags & 0x0020) o += 9;                              // layout
    while (d[o] !== 0) o += 1; o += 1;                       // variable name
    if (!(flags & 0x8000)) throw new Error('UI_1.swf: source edit text carries no initial text');
    const textHead = Buffer.from(d.slice(0, o));
    textHead.writeUInt16LE(NEW_TEXT_ID, 0);
    const newTextTag = makeTag(37, Buffer.concat([textHead, Buffer.from(BUTTON_LABEL, 'utf8'), Buffer.from([0])]));

    // Sprite clones, each repointed at the clone one level down.
    const cloneSprite = (tag, newId, swaps) => {
        const data = Buffer.from(body.slice(tag.dataStart, tag.end));
        data.writeUInt16LE(newId, 0);
        let hits = 0;
        for (const sub of parseTags(data, 4, data.length)) {
            if (sub.code !== 26 && sub.code !== 70) continue;
            let p = sub.dataStart;
            const flags1 = data[p]; p += 1;
            if (sub.code === 70) p += 1;  // PlaceObject3 has a second flag byte
            p += 2;                       // depth
            if (!(flags1 & 2)) continue;  // no character id
            const cid = data.readUInt16LE(p);
            if (swaps.has(cid)) { data.writeUInt16LE(swaps.get(cid), p); hits += 1; }
        }
        if (hits !== swaps.size) throw new Error(`UI_1.swf: sprite ${newId} expected ${swaps.size} swaps, made ${hits}`);
        return makeTag(39, data);
    };
    const newInnerTag = cloneSprite(tInner, NEW_INNER_ID, new Map([[SRC_TEXT_ID, NEW_TEXT_ID]]));
    const newButtonTag = cloneSprite(tButton, NEW_BUTTON_ID, new Map([[SRC_INNER_ID, NEW_INNER_ID]]));

    // Place the clone in a_DyeWindow, one button above am_Apply.
    const winSubs = parseTags(body, tWindow.dataStart + 4, tWindow.end);
    let applyMatrixOffset = null;
    const usedDepths = new Set();
    for (const sub of winSubs) {
        if (sub.code !== 26 && sub.code !== 70) continue;
        let p = sub.dataStart;
        const flags1 = body[p]; p += 1;
        if (sub.code === 70) p += 1;
        usedDepths.add(body.readUInt16LE(p)); p += 2;
        if (sub.code === 26 && (flags1 & 2) && body.readUInt16LE(p) === SRC_BUTTON_ID) applyMatrixOffset = p + 2;
    }
    if (applyMatrixOffset === null) throw new Error('UI_1.swf: am_Apply placement not found in a_DyeWindow');
    if (usedDepths.has(NEW_DEPTH)) throw new Error(`UI_1.swf: depth ${NEW_DEPTH} is already taken`);

    const matrix = decodeMatrix(body, applyMatrixOffset);
    matrix.ty += Y_OFFSET_TWIPS;
    const placeHead = Buffer.alloc(5);
    placeHead[0] = 0x26; // HasName | HasMatrix | HasCharacter
    placeHead.writeUInt16LE(NEW_DEPTH, 1);
    placeHead.writeUInt16LE(NEW_BUTTON_ID, 3);
    const newPlaceTag = makeTag(26, Buffer.concat([
        placeHead, encodeMatrix(matrix), Buffer.from(INSTANCE_NAME, 'utf8'), Buffer.from([0])
    ]));

    const showFrame = [...winSubs].reverse().find((s) => s.code === 1);
    if (!showFrame) throw new Error('UI_1.swf: a_DyeWindow has no ShowFrame');
    const newWindowTag = makeTag(39, Buffer.concat([
        body.slice(tWindow.dataStart, showFrame.start),
        newPlaceTag,
        body.slice(showFrame.start, tWindow.end)
    ]));

    return Buffer.concat([
        body.slice(0, tButton.end),
        newTextTag, newInnerTag, newButtonTag,
        body.slice(tButton.end, tWindow.start),
        newWindowTag,
        body.slice(tWindow.end)
    ]);
}

/**
 * Rewrites the existing am_Default placement from am_Apply's matrix plus Y_OFFSET_TWIPS,
 * so the gap between the two buttons can be retuned by editing that one constant and
 * re-running. Without this the UI step is skip-if-present and the only way to move the
 * button is to restore UI_1.swf from a commit that predates it.
 */
function repositionDefaultButton(swf) {
    const body = swf.body;
    const tags = parseTags(body, rectByteLen(body, 0) + 4, body.length);
    const tWindow = tags.find((t) => t.code === 39 && body.readUInt16LE(t.dataStart) === DYE_WINDOW_ID);
    if (!tWindow) throw new Error('UI_1.swf: a_DyeWindow not found');

    let applyMatrixOffset = null;
    let placement = null;
    for (const sub of parseTags(body, tWindow.dataStart + 4, tWindow.end)) {
        if (sub.code !== 26) continue;
        let p = sub.dataStart;
        const flags1 = body[p]; p += 1;
        const depth = body.readUInt16LE(p); p += 2;
        if (!(flags1 & 2)) continue;
        const charId = body.readUInt16LE(p);
        if (charId === SRC_BUTTON_ID) applyMatrixOffset = p + 2;
        if (charId === NEW_BUTTON_ID) placement = { sub, depth };
    }
    if (applyMatrixOffset === null) throw new Error('UI_1.swf: am_Apply placement not found');
    if (!placement) throw new Error('UI_1.swf: am_Default placement not found');

    const matrix = decodeMatrix(body, applyMatrixOffset);
    matrix.ty += Y_OFFSET_TWIPS;
    const placeHead = Buffer.alloc(5);
    placeHead[0] = 0x26; // HasName | HasMatrix | HasCharacter
    placeHead.writeUInt16LE(placement.depth, 1);
    placeHead.writeUInt16LE(NEW_BUTTON_ID, 3);
    const newPlaceTag = makeTag(26, Buffer.concat([
        placeHead, encodeMatrix(matrix), Buffer.from(INSTANCE_NAME, 'utf8'), Buffer.from([0])
    ]));

    const newWindowTag = makeTag(39, Buffer.concat([
        body.slice(tWindow.dataStart, placement.sub.start),
        newPlaceTag,
        body.slice(placement.sub.end, tWindow.end)
    ]));
    return Buffer.concat([
        body.slice(0, tWindow.start),
        newWindowTag,
        body.slice(tWindow.end)
    ]);
}

// ---------------------------------------------------------------------------
// DungeonBlitz.swf / class_121 P-code
// ---------------------------------------------------------------------------

function exportPcode(ffdecPath, swfPath, outDir, className) {
    const dir = path.join(outDir, className);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    runFfdec(ffdecPath, ['-format', 'script:pcode', '-selectclass', className, '-export', 'script', dir, swfPath]);
    const file = path.join(dir, 'scripts', `${className}.pcode`);
    if (!fs.existsSync(file)) throw new Error(`FFDec did not export ${className}.pcode`);
    return fs.readFileSync(file, 'utf8').replace(/\r/g, '');
}

/**
 * Returns the method's whole `trait method ... end ; method` block, not just its
 * instructions. Feeding `-replace` only the instruction list rewrites the method
 * signature from scratch: param_count drops to 0 and HAS_OPTIONAL is lost, so
 * class_33 then calls a one-argument handler with one argument too many and the
 * ArgumentError takes the entire dye screen down. The full block round-trips
 * byte-for-byte.
 */
function traitIndex(lines, name) {
    const traits = [];
    lines.forEach((line, i) => { if (line.startsWith('trait method QName(')) traits.push({ line, i }); });
    const at = traits.findIndex((t) => t.line.endsWith(`,"${name}")`));
    if (at < 0) throw new Error(`class_121: trait ${name} not found`);
    return { ordinal: at, start: traits[at].i };
}

function methodTrait(pcode, name) {
    const lines = pcode.split('\n').map((l) => l.trim());
    const { start } = traitIndex(lines, name);
    const end = lines.findIndex((l, i) => i > start && l === 'end ; method');
    if (end < 0) throw new Error(`class_121: could not delimit ${name}`);
    return lines.slice(start, end + 1).join('\n');
}

function bodyIndexOf(pcode, name) {
    const lines = pcode.split('\n').map((l) => l.trim());
    return FIRST_TRAIT_BODY + traitIndex(lines, name).ordinal;
}

function replaceOnce(body, needle, replacement, what) {
    const parts = body.split(needle);
    if (parts.length !== 2) throw new Error(`class_121: expected exactly one ${what}, found ${parts.length - 1}`);
    return parts[0] + replacement + parts[1];
}

// `param1.currentTarget === var_2.am_Default`, with both dereferences guarded:
// class_93 re-enters OnApplyDyes with a synthetic `new MouseEvent(CLICK)` whose
// currentTarget is null, and var_2 is the currently open screen clip rather than
// a field of this class.
const IS_DEFAULT_CLICK = (skipLabel) => [
    'getlocal1',
    'pushnull',
    `ifeq ${skipLabel}`,
    'getlocal1',
    'getproperty QName(PackageNamespace(""),"currentTarget")',
    'pushnull',
    `ifeq ${skipLabel}`,
    'getlex QName(PackageInternalNs(""),"var_2")',
    'pushnull',
    `ifeq ${skipLabel}`,
    'getlocal1',
    'getproperty QName(PackageNamespace(""),"currentTarget")',
    'getlex QName(PackageInternalNs(""),"var_2")',
    `getproperty ${AM_DEFAULT}`,
    `ifstrictne ${skipLabel}`
].join('\n');

// Every slot class_121 builds a pending-dye pair for, in OnInitDisplay order.
const DYE_SLOTS = ['ARMOR_SLOT', 'GLOVES_SLOT', 'BOOTS_SLOT', 'HAT_SLOT', 'SWORD_SLOT', 'SHIELD_SLOT'];

// `var_75[EntType.<slot>][sub] = new class_21()` - dye id 0, i.e. "back to undyed".
const STAGE_DEFAULT_DYE = (slot, sub) => [
    'getlocal0',
    `getproperty ${VAR_75}`,
    'getlex QName(PackageNamespace(""),"EntType")',
    `getproperty QName(PackageNamespace(""),"${slot}")`,
    `getproperty ${ML}`,
    `pushbyte ${sub}`,
    `findpropstrict ${CLASS_21}`,
    `constructprop ${CLASS_21}, 0`,
    `coerce ${CLASS_21}`,
    `setproperty ${ML}`
].join('\n');

function injectOnApplyDyes(body) {
    // A click on Default Dyes only stages the reset - it must not send anything. Mark every
    // gear slot as "revert to undyed", let Refresh() reprice and light up Apply Dyes, and
    // return before the packet is built. Shirt and pants are var_202 / var_204 and are left
    // untouched on purpose.
    const anchor = ['pushnull', 'coerce QName(PackageNamespace(""),"class_21")', 'setlocal 12'].join('\n');
    const at = body.indexOf(anchor);
    if (at < 0) throw new Error('class_121: OnApplyDyes local prologue not found');
    // Unrolled on purpose. A `for` loop here is a back edge, and real Flash rejects an
    // injected back edge with VerifyError #1021 - its verifier walks instruction boundaries
    // by control-flow reachability and disagrees with the linear parse FFDec (and every
    // check in this script) does. Six slots, so unrolling costs nothing and needs no extra
    // register either. Forward branches only.
    const staging = [
        anchor,
        IS_DEFAULT_CLICK('dbDefaultDyesSkip'),
        ...DYE_SLOTS.flatMap((slot) => [STAGE_DEFAULT_DYE(slot, 0), STAGE_DEFAULT_DYE(slot, 1)]),
        // Exactly what picking a dye does (method_96): OnRefreshScreen only reprices and
        // rebuilds the paper doll - method_1571 - when var_972 is set. Refresh() on its own
        // just redraws the collected-dyes panel.
        'getlocal0',
        'pushtrue',
        `initproperty ${VAR_972}`,
        'findpropstrict QName(PackageNamespace(""),"Refresh")',
        'callpropvoid QName(PackageNamespace(""),"Refresh"), 0',
        'returnvoid',
        'dbDefaultDyesSkip:'
    ].join('\n');
    return body.slice(0, at) + staging + body.slice(at + anchor.length);
}

const LU_ML = 'MultinameL([PackageNamespace(""),Namespace("http://adobe.com/AS3/2006/builtin"),'
    + 'PackageInternalNs(""),PrivateNamespace("LinkUpdater"),ProtectedNamespace("LinkUpdater"),'
    + 'StaticProtectedNs("LinkUpdater"),PrivateNamespace("LinkUpdater.as$121")])';

/**
 * LinkUpdater.method_1470 applies an equipment update to `entType.equippedGear` and leaves
 * `Entity.mEquipGear` alone. Nothing else writes mEquipGear either, outside the login
 * packet - so the gear *id* list the client keeps is frozen at whatever the player logged in
 * with. Two things break off that: the dye screen builds its rows from it, and
 * `LinkUpdater.WriteUpdateEquipment` diffs against it to decide which slots to tell the
 * server about, so after one set swap the diff is computed against the login set and a swap
 * back reports nothing changed at all.
 *
 * Keep mEquipGear in step here: per updated slot write the gear id back, or 0 when the slot
 * was cleared. Guarded on mEquipGear being non-null, since Entity nulls it on teardown.
 */
function injectEquipGearSync(body) {
    const anchor = `setproperty ${LU_ML}`;
    const patched = replaceOnce(body, `\n${anchor}\n`, '\n' + [
        anchor,
        'getlocal3',
        'getproperty QName(PackageInternalNs(""),"mEquipGear")',
        'pushnull',
        'ifeq dbEquipGearDone',
        'getlocal3',
        'getproperty QName(PackageInternalNs(""),"mEquipGear")',
        'getlocal 5',
        'pushbyte 0',
        `setproperty ${LU_ML}`,
        'getlocal 8',
        'pushnull',
        'ifeq dbEquipGearDone',
        'getlex QName(PackageNamespace(""),"class_14")',
        'getproperty QName(PackageNamespace(""),"gearTypesDict")',
        'getlocal 8',
        'getproperty QName(PackageInternalNs(""),"gearName")',
        `getproperty ${LU_ML}`,
        'setlocal 9',
        'getlocal 9',
        'pushnull',
        'ifeq dbEquipGearDone',
        'getlocal3',
        'getproperty QName(PackageInternalNs(""),"mEquipGear")',
        'getlocal 5',
        'getlocal 9',
        'getproperty QName(PackageInternalNs(""),"gearID")',
        'convert_u',
        `setproperty ${LU_ML}`,
        'dbEquipGearDone:'
    ].join('\n') + '\n', 'method_1470 equippedGear write');

    return replaceOnce(patched, '\nlocalcount 9\n', '\nlocalcount 10\n', 'method_1470 localcount');
}

/**
 * LinkUpdater.method_1974 reads the server's dye-sync packet and, for both the gear type's
 * colours and the owned gear's dye objects, writes each one only `if (dyeId)`. The stock
 * game could never clear a dye, so 0 meant "no change" - which silently threw away every
 * reset: the character kept its old colours and, because the client's own copy of the gear
 * stayed dyed, the staged reset kept reading as a pending change, so Apply Dyes stayed lit
 * and charged again on every click.
 *
 * Making the four writes unconditional is enough. `class_14.var_194[0]` is undefined, which
 * coerces to null on the class_21 slots, and var_644 / var_705 are uint so they take 0 -
 * exactly the "no dye" state the renderer already checks for.
 */
function injectDyeSync(body) {
    const lines = body.split('\n');
    for (const prop of ['var_644', 'var_705', 'var_295', 'var_307']) {
        const setter = `setproperty QName(PackageInternalNs(""),"${prop}")`;
        const hits = lines.reduce((n, l, i) => (l === setter ? [...n, i] : n), []);
        if (hits.length !== 1) throw new Error(`LinkUpdater: expected one ${prop} write, found ${hits.length}`);
        let guard = hits[0];
        while (guard >= 0 && !/^iffalse ofs[0-9a-f]{4}$/.test(lines[guard])) guard -= 1;
        if (guard <= 0) throw new Error(`LinkUpdater: no guard found before the ${prop} write`);
        if (!/^getlocal (8|9)$/.test(lines[guard - 1])) {
            throw new Error(`LinkUpdater: unexpected guard "${lines[guard - 1]}" before the ${prop} write`);
        }
        lines[guard - 1] = 'pushtrue';
    }
    return lines.join('\n');
}

/**
 * method_1869 fills the dye screen's six rows - gear icon, enabled state and the pending
 * dye pair - from `clientEnt.mEquipGear[slot]`. That vector is written in exactly one place
 * in the whole client, LinkUpdater.method_1379, which is the login packet: equipping gear
 * updates `entType.equippedGear` (LinkUpdater.method_1470) and never touches mEquipGear, and
 * the server does not even send that update back to the player who equipped. So the dye
 * screen kept showing whatever set the player logged in with.
 *
 * Fix: derive the gear id from `entType.equippedGear[slot].gearName` through
 * class_14.gearTypesDict, which is what LinkUpdater.method_1974 already does, and fall back
 * to mEquipGear when the lookup comes up empty.
 */
function injectEquippedGearLookup(body) {
    const anchor = [
        'getlocal1',
        'getproperty QName(PackageInternalNs(""),"mEquipGear")',
        'getlocal2',
        `getproperty ${ML}`,
        'convert_u'
    ].join('\n');
    const patched = replaceOnce(body, anchor, [
        anchor,
        'setlocal 13',                     // fallback: the login-time gear id
        'getlocal1',
        'getproperty QName(PackageInternalNs(""),"entType")',
        'getproperty QName(PackageInternalNs(""),"equippedGear")',
        'getlocal2',
        `getproperty ${ML}`,
        'setlocal 14',
        'getlocal 14',
        'pushnull',
        'ifeq dbEquippedGearDone',
        'getlex QName(PackageNamespace(""),"class_14")',
        'getproperty QName(PackageNamespace(""),"gearTypesDict")',
        'getlocal 14',
        'getproperty QName(PackageInternalNs(""),"gearName")',
        `getproperty ${ML}`,
        'setlocal 14',
        'getlocal 14',
        'pushnull',
        'ifeq dbEquippedGearDone',
        'getlocal 14',
        'getproperty QName(PackageInternalNs(""),"gearID")',
        'convert_u',
        'setlocal 13',
        'dbEquippedGearDone:',
        'getlocal 13'
    ].join('\n'), 'method_1869 mEquipGear read');

    return replaceOnce(patched, '\nlocalcount 13\n', '\nlocalcount 15\n', 'method_1869 localcount');
}

// A staged reset is a class_21 with dye id 0. Left alone, method_536 would skin the slot's
// bottle with colour 0 and the player would see a black dye where they asked for none.
function injectMethod536(body) {
    const anchor = [
        'pushnull',
        'coerce QName(PackageNamespace("flash.display"),"MovieClip")',
        'setlocal 4'
    ].join('\n');
    return replaceOnce(body, anchor, [
        anchor,
        'getlocal1',
        'pushnull',
        'ifeq dbDefaultDyesIconDone',
        'getlocal1',
        'getproperty QName(PackageInternalNs(""),"var_57")',
        'pushbyte 0',
        'ifne dbDefaultDyesIconDone',
        'pushnull',
        `coerce ${CLASS_21}`,
        'setlocal1',
        'dbDefaultDyesIconDone:'
    ].join('\n'), 'method_536 local prologue');
}

function injectOnCreateScreen(body) {
    const anchor = '\ninitproperty QName(PrivateNamespace("*","11"),"var_1437")\n';
    return replaceOnce(body, anchor, anchor + [
        'findpropstrict QName(PackageNamespace(""),"method_5")',
        'getlex QName(PackageInternalNs(""),"var_2")',
        `getproperty ${AM_DEFAULT}`,
        'getlocal0',
        'getproperty QName(PackageNamespace(""),"OnApplyDyes")',
        'callproperty QName(PackageNamespace(""),"method_5"), 2',
        'pop'
    ].join('\n') + '\n', 'OnCreateScreen var_1437 anchor');
}

/**
 * Real Flash rejects a branch that jumps backwards into injected code with
 * VerifyError #1021, and neither FFDec nor a linear branch-boundary check sees anything
 * wrong. The only defence is to never emit one, so make that a build failure rather than
 * something that shows up as a frozen client three test rounds later.
 */
function assertNoInjectedBackEdge(src, method) {
    const lines = src.split('\n').map((l) => l.trim());
    const labelAt = new Map();
    lines.forEach((line, i) => {
        const m = /^(db\w+):$/.exec(line);
        if (m) labelAt.set(m[1], i);
    });
    lines.forEach((line, i) => {
        const m = /^(?:jump|if\w+)\s+(db\w+)$/.exec(line);
        if (!m) return;
        if (!labelAt.has(m[1])) throw new Error(`${method}: branch to undefined label ${m[1]}`);
        if (labelAt.get(m[1]) < i) throw new Error(`${method}: back edge to ${m[1]} will fail AVM2 verification`);
    });
}

// [class, method, transform, -replace body index]. The indices come from swfPatchUtils'
// methodIdxForTrait, which agrees with FFDec's body index; class_121's are cross-checked
// against its trait order below, and every one of them is re-verified after patching.
const EDITS = [
    ['class_121', 'OnCreateScreen', injectOnCreateScreen, 2175],
    ['class_121', 'method_536', injectMethod536, 2183],
    ['class_121', 'method_1869', injectEquippedGearLookup, 2184],
    ['class_121', 'OnApplyDyes', injectOnApplyDyes, 2186],
    ['LinkUpdater', 'method_1974', injectDyeSync, 3558],
    ['LinkUpdater', 'method_1470', injectEquipGearSync, 3624]
];

function patchGameSwf(ffdecPath, swfPath, workRoot) {
    const sources = new Map();
    for (const [className] of EDITS) {
        if (!sources.has(className)) {
            sources.set(className, exportPcode(ffdecPath, swfPath, path.join(workRoot, 'base'), className));
        }
    }
    for (const [className, name, , bodyIndex] of EDITS) {
        if (className !== 'class_121') continue;
        if (bodyIndexOf(sources.get(className), name) !== bodyIndex) {
            throw new Error(`class_121 trait order moved; ${name} is no longer body ${bodyIndex}`);
        }
    }

    let input = swfPath;
    EDITS.forEach(([className, name, inject, bodyIndex], step) => {
        const file = path.join(workRoot, `${className}.${name}.pcode`);
        const src = inject(methodTrait(sources.get(className), name));
        assertNoInjectedBackEdge(src, name);
        fs.writeFileSync(file, src + '\n', 'utf8');
        const output = path.join(workRoot, `stage${step + 1}.swf`);
        runFfdec(ffdecPath, ['-replace', input, output, className, file, String(bodyIndex)]);
        input = output;
    });
    fs.copyFileSync(input, swfPath);
}

function verifyGameSwf(ffdecPath, swfPath, workRoot) {
    const verifyRoot = path.join(workRoot, 'verify');
    const pcode = exportPcode(ffdecPath, swfPath, verifyRoot, 'class_121');
    const ocs = methodTrait(pcode, 'OnCreateScreen');
    const oad = methodTrait(pcode, 'OnApplyDyes');
    const icon = methodTrait(pcode, 'method_536');
    const luPcode = exportPcode(ffdecPath, swfPath, verifyRoot, 'LinkUpdater');
    const sync = methodTrait(luPcode, 'method_1974');
    const equip = methodTrait(luPcode, 'method_1470');
    const count = (haystack, needle) => haystack.split(needle).length - 1;

    if (count(equip, 'getproperty QName(PackageInternalNs(""),"mEquipGear")') !== 3) {
        throw new Error('LinkUpdater.method_1470 does not keep mEquipGear in step');
    }
    if (!equip.includes('localcount 10')) {
        throw new Error('LinkUpdater.method_1470 was not given a register for the gear type');
    }

    // All four dye-sync writes must be unconditional, or a cleared dye is thrown away.
    for (const prop of ['var_644', 'var_705', 'var_295', 'var_307']) {
        const at = sync.split('\n').indexOf(`setproperty QName(PackageInternalNs(""),"${prop}")`);
        if (at < 0) throw new Error(`LinkUpdater.method_1974 lost its ${prop} write`);
        const before = sync.split('\n').slice(0, at);
        const guard = before.map((l, i) => [l, i]).reverse().find(([l]) => /^iffalse ofs[0-9a-f]{4}$/.test(l));
        if (!guard || before[guard[1] - 1] !== 'pushtrue') {
            throw new Error(`LinkUpdater.method_1974 still skips ${prop} when the dye id is 0`);
        }
    }

    // The signature must survive: class_33 always calls the handler with the event.
    for (const needle of [
        'flag HAS_OPTIONAL',
        'param QName(PackageNamespace("flash.events"),"MouseEvent")',
        'param QName(PackageNamespace(""),"Boolean")',
        'optional False()'
    ]) {
        if (!oad.includes(needle)) throw new Error(`class_121.OnApplyDyes lost its signature (${needle})`);
    }
    if (count(ocs, `getproperty ${AM_DEFAULT}`) !== 1) {
        throw new Error('class_121.OnCreateScreen does not wire am_Default exactly once');
    }
    if (!ocs.includes('callproperty QName(PackageNamespace(""),"method_5"), 2')) {
        throw new Error('class_121.OnCreateScreen lost its method_5 call');
    }
    if (count(oad, `getproperty ${AM_DEFAULT}`) !== 1) {
        throw new Error('class_121.OnApplyDyes does not test am_Default exactly once');
    }
    if (count(oad, `constructprop ${CLASS_21}, 0`) !== DYE_SLOTS.length * 2) {
        throw new Error('class_121.OnApplyDyes does not stage every gear slot');
    }
    if (count(oad, `initproperty ${VAR_972}`) !== 1) {
        throw new Error('class_121.OnApplyDyes does not mark the screen for repricing');
    }
    if (count(oad, 'callpropvoid QName(PackageNamespace(""),"Refresh"), 0') !== 2) {
        throw new Error('class_121.OnApplyDyes does not refresh after staging');
    }
    if (count(icon, 'getproperty QName(PackageInternalNs(""),"var_57")') !== 1) {
        throw new Error('class_121.method_536 does not test the dye id');
    }
    const rows = methodTrait(pcode, 'method_1869');
    if (count(rows, 'getproperty QName(PackageNamespace(""),"gearTypesDict")') !== 1) {
        throw new Error('class_121.method_1869 still reads the equipped set from mEquipGear alone');
    }
    if (!rows.includes('localcount 15')) {
        throw new Error('class_121.method_1869 was not given registers for the gear lookup');
    }
    // Every branch target must still resolve; FFDec prints unresolved ones as raw offsets.
    for (const src of [ocs, oad, icon]) {
        const labels = new Set([...src.matchAll(/^(\S+):$/gm)].map((m) => m[1]));
        for (const m of src.matchAll(/^(?:jump|if\w+)\s+(\S+)$/gm)) {
            if (!labels.has(m[1])) throw new Error(`class_121: unresolved branch target ${m[1]}`);
        }
    }
}

// ---------------------------------------------------------------------------

function bumpClientRev(gameSwfPath) {
    const file = path.resolve(REPO_ROOT, INDEX_HTML);
    if (!fs.existsSync(file)) return;
    const digest = crypto.createHash('sha1').update(fs.readFileSync(gameSwfPath)).digest('hex').slice(0, 12);
    const html = fs.readFileSync(file, 'utf8');
    const next = html.replace(/clientrev=[^&"'`$]+/, `clientrev=swf-${digest}`);
    if (next !== html) fs.writeFileSync(file, next, 'utf8');
}

// Both SWFs are tracked, so `git checkout -- <swf>` is the revert. No .bak files:
// stale ones have caused more trouble than they have saved here.

function main() {
    const args = parseArgs(process.argv.slice(2));
    const uiSwfPath = path.resolve(REPO_ROOT, args.uiSwf);
    const gameSwfPath = path.resolve(REPO_ROOT, args.gameSwf);
    const ffdecPath = detectFfdec(args.ffdec);

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    for (const file of [uiSwfPath, gameSwfPath]) {
        if (!fs.existsSync(file)) throw new Error(`SWF not found: ${file}`);
    }

    const workRoot = path.join(REPO_ROOT, 'build', 'ffdec-dye-default-button');
    fs.mkdirSync(workRoot, { recursive: true });

    if (!args.verify) {
        const uiSwf = loadSwf(uiSwfPath);
        if (uiHasDefaultButton(uiSwf)) {
            saveSwf(uiSwfPath, uiSwf, repositionDefaultButton(uiSwf));
            console.log(`UI_1.swf already carries am_Default; re-placed it ${-Y_OFFSET_TWIPS / 20} px above am_Apply.`);
        } else {
            saveSwf(uiSwfPath, uiSwf, patchUiSwf(uiSwf));
        }

        const probe = exportPcode(ffdecPath, gameSwfPath, path.join(workRoot, 'probe'), 'class_121');
        const alreadyWired = probe.includes(INSTANCE_NAME);
        if (alreadyWired) {
            console.log('class_121 already references am_Default, leaving it alone.');
        } else {
            patchGameSwf(ffdecPath, gameSwfPath, workRoot);
        }
        bumpClientRev(gameSwfPath);
    }

    if (!uiHasDefaultButton(loadSwf(uiSwfPath))) throw new Error('UI_1.swf is missing the am_Default button');
    verifyGameSwf(ffdecPath, gameSwfPath, workRoot);
    console.log(`${args.verify ? 'Verified' : 'Patched'} the Default Dyes button in ${args.uiSwf} + ${args.gameSwf}`);
}

main();
