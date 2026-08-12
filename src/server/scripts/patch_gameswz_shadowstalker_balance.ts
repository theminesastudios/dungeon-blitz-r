import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type Stats = { powers: number; entities: number; changes: number };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const POWER_XML = path.join(XML_DIR, "PlayerPowerTypes.xml");
const ENT_XML = path.join(XML_DIR, "EntTypes.xml");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");

const cloneHp = [1, 1, 1.15, 1.15, 1.15, 1.3, 1.3, 1.3, 1.45, 1.45, 1.45];
const cloneDefense = [1, 1, 1, 1.15, 1.15, 1.15, 1.3, 1.3, 1.3, 1.45, 1.45];

function replaceTag(block: string, tag: string, value: string, stats: Stats): string {
  const pattern = new RegExp(`<${tag}>[^<]*<\\/${tag}>`);
  if (!pattern.test(block)) return block;
  const next = block.replace(pattern, `<${tag}>${value}</${tag}>`);
  if (next !== block) stats.changes += 1;
  return next;
}

function upsertAfter(block: string, afterTag: string, tag: string, value: string, stats: Stats): string {
  if (new RegExp(`<${tag}>`).test(block)) return replaceTag(block, tag, value, stats);
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const next = block.replace(
    new RegExp(`(<${afterTag}>[^<]*<\\/${afterTag}>)`),
    `$1${newline}\t\t<${tag}>${value}</${tag}>`,
  );
  if (next !== block) stats.changes += 1;
  return next;
}

function addBuff(block: string, buff: string, stats: Stats): string {
  const match = block.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/);
  if (!match) {
    const newline = block.includes("\r\n") ? "\r\n" : "\n";
    const next = block.replace(
      /(<PowerGroup>[^<]*<\/PowerGroup>)/,
      `$1${newline}\t\t<AddTargetBuff>${buff}</AddTargetBuff>`,
    );
    if (next !== block) stats.changes += 1;
    return next;
  }
  const buffs = match[1].split(",").filter(Boolean);
  if (buffs.includes(buff)) return block;
  buffs.push(buff);
  stats.changes += 1;
  return block.replace(match[0], `<AddTargetBuff>${buffs.join(",")}</AddTargetBuff>`);
}

function removeBuff(block: string, buff: string, stats: Stats): string {
  const match = block.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/);
  if (!match) return block;
  const buffs = match[1].split(",").filter((candidate) => candidate && candidate !== buff);
  if (buffs.length === match[1].split(",").filter(Boolean).length) return block;
  stats.changes += 1;
  if (buffs.length > 0) {
    return block.replace(match[0], `<AddTargetBuff>${buffs.join(",")}</AddTargetBuff>`);
  }
  return block.replace(/^[ \t]*<AddTargetBuff>[^<]*<\/AddTargetBuff>\r?\n/m, "");
}

function addCloneTendrilGfx(block: string, stats: Stats): string {
  if (!/<FireGfx\/>/.test(block)) return block;
  const gfx = [
    "<FireGfx>",
    "\t\t\t<AnimFile>SFX_2.swf</AnimFile>",
    "\t\t\t<AnimClass>a_ShadowCloud_Random_1_3</AnimClass>",
    "\t\t\t<AnimScale>.5</AnimScale>",
    "\t\t\t<FireAndForget>true</FireAndForget>",
    "\t\t</FireGfx>",
  ].join("\n");
  stats.changes += 1;
  return block.replace("<FireGfx/>", gfx).replace("</FireGfx>\r\n", "</FireGfx>\n");
}

function rankOf(powerName: string, base: string): number {
  if (powerName === base) return 0;
  return Number(powerName.slice(base.length)) || 0;
}

function tagValue(block: string, tag: string): string | undefined {
  return block.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`))?.[1];
}

function addRankedClonePowers(xml: string, stats: Stats): string {
  let patched = xml;
  const definitions = [
    { clone: "FalseChi", source: "DarkChi", firstId: 7100, copyBuffs: true },
    { clone: "FalseTendrilDash", source: "ShadowTendrilDash", firstId: 7110, copyBuffs: false },
  ];

  for (const definition of definitions) {
    const template = patched.match(new RegExp(`<Power PowerName="${definition.clone}">[\\s\\S]*?<\\/Power>`))?.[0];
    if (!template) continue;
    const additions: string[] = [];
    for (let rank = 1; rank <= 10; rank += 1) {
      const powerName = `${definition.clone}${rank}`;
      if (patched.includes(`PowerName="${powerName}"`)) continue;
      const source = patched.match(new RegExp(`<Power PowerName="${definition.source}${rank}">[\\s\\S]*?<\\/Power>`))?.[0];
      if (!source) continue;
      let clone = template
        .replace(`PowerName="${definition.clone}"`, `PowerName="${powerName}"`)
        .replace(/<PowerID>[^<]*<\/PowerID>/, `<PowerID>${definition.firstId + rank - 1}</PowerID>`);
      const damage = tagValue(source, "BaseDamageMult");
      if (damage !== undefined) clone = clone.replace(/<BaseDamageMult>[^<]*<\/BaseDamageMult>/, `<BaseDamageMult>${damage}</BaseDamageMult>`);
      if (definition.copyBuffs) {
        const buffs = tagValue(source, "AddTargetBuff");
        if (buffs !== undefined) clone = clone.replace(/<AddTargetBuff>[^<]*<\/AddTargetBuff>/, `<AddTargetBuff>${buffs}</AddTargetBuff>`);
      }
      additions.push(clone);
    }
    if (additions.length > 0) {
      const newline = template.includes("\r\n") ? "\r\n" : "\n";
      patched = patched.replace(template, `${template}${newline}\t${additions.join(`${newline}\t`)}`);
      stats.powers += additions.length;
      stats.changes += additions.length;
    }
  }
  return patched;
}

function addRankedScorpionPowers(xml: string, stats: Stats): string {
  let patched = xml;
  const additions: string[] = [];
  for (let rank = 0; rank <= 10; rank += 1) {
    const suffix = rank === 0 ? "" : String(rank);
    const powerName = `FalseScorpionSting${suffix}`;
    if (patched.includes(`PowerName="${powerName}"`)) continue;
    const sourceName = `CrippleStrike${suffix}`;
    const source = patched.match(new RegExp(`<Power PowerName="${sourceName}">[\\s\\S]*?<\\/Power>`))?.[0];
    if (!source) continue;
    let clone = source
      .replace(`PowerName="${sourceName}"`, `PowerName="${powerName}"`)
      .replace(/<PowerID>[^<]*<\/PowerID>/, `<PowerID>${7120 + rank}</PowerID>`)
      .replace(/<ManaCost>[^<]*<\/ManaCost>/, "<ManaCost>0</ManaCost>")
      .replace(/<CoolDownTime>[^<]*<\/CoolDownTime>/, "<CoolDownTime>0</CoolDownTime>")
      .replace(/<ProcModifier>[^<]*<\/ProcModifier>/, "<ProcModifier>0</ProcModifier>")
      .replace(/<PowerGroup>[^<]*<\/PowerGroup>/, "<PowerGroup>ShadowLegion</PowerGroup>")
      .replace(/^[ \t]*<FromMasterMana>[^<]*<\/FromMasterMana>\r?\n/m, "")
      .replace(/^[ \t]*<BasePowerName>[^<]*<\/BasePowerName>\r?\n/m, "");
    clone = addBuff(clone, "Bound", stats);
    clone = upsertAfter(clone, "AddTargetBuff", "AggroBonus", "1.5", stats);
    additions.push(clone);
  }
  if (additions.length > 0) {
    const anchor = patched.match(/<Power PowerName="FalseTendrilDash(?:10)?">[\s\S]*?<\/Power>/)?.[0];
    if (anchor) {
      const newline = anchor.includes("\r\n") ? "\r\n" : "\n";
      patched = patched.replace(anchor, `${anchor}${newline}\t${additions.join(`${newline}\t`)}`);
      stats.powers += additions.length;
      stats.changes += additions.length;
    }
  }
  return patched;
}

/**
 * Keep clone attacks mechanically identical to the owner's matching rank. The clone-only
 * PowerName/BasePowerName/PowerID and resource fields stay separate so the loader treats the
 * clone powers as their own ranked families and the AI can rotate them without consuming the
 * owner's mana or colliding with player cooldowns. Runtime patches alias these False* base
 * names to the matching player behavior. Hate and Bind remain clone-only bonuses.
 */
function syncClonePowers(xml: string, stats: Stats): string {
  let patched = xml;
  const definitions = [
    { clone: "FalseChi", source: "DarkChi", baseId: 1445, firstRankId: 7100 },
    { clone: "FalseTendrilDash", source: "ShadowTendrilDash", baseId: 1509, firstRankId: 7110 },
    { clone: "FalseScorpionSting", source: "CrippleStrike", baseId: 7120, firstRankId: 7121 },
  ] as const;

  for (const definition of definitions) {
    for (let rank = 0; rank <= 10; rank += 1) {
      const suffix = rank === 0 ? "" : String(rank);
      const sourceName = `${definition.source}${suffix}`;
      const cloneName = `${definition.clone}${suffix}`;
      const source = patched.match(new RegExp(`<Power PowerName="${sourceName}">[\\s\\S]*?<\\/Power>`))?.[0];
      const current = patched.match(new RegExp(`<Power PowerName="${cloneName}">[\\s\\S]*?<\\/Power>`))?.[0];
      if (!source || !current) continue;

      const localStats: Stats = { powers: 0, entities: 0, changes: 0 };
      let clone = source
        .replace(`PowerName="${sourceName}"`, `PowerName="${cloneName}"`)
        .replace(/^[ \t]*<FromMasterMana>[^<]*<\/FromMasterMana>\r?\n/m, "");
      clone = replaceTag(clone, "PowerID", String(rank === 0 ? definition.baseId : definition.firstRankId + rank - 1), localStats);
      clone = upsertAfter(clone, "DisplayName", "BasePowerName", definition.clone, localStats);
      clone = clone.replace(
        /(<BasePowerName>[^<]*<\/BasePowerName>)\r\n/,
        "$1\n",
      );
      clone = replaceTag(clone, "ManaCost", "0", localStats);
      clone = replaceTag(clone, "CoolDownTime", "0", localStats);
      clone = replaceTag(clone, "PowerGroup", "ShadowLegion", localStats);
      clone = addBuff(clone, "Bound", localStats);
      clone = upsertAfter(clone, "AddTargetBuff", "AggroBonus", "1.5", localStats);
      if (definition.clone === "FalseTendrilDash") {
        clone = addCloneTendrilGfx(clone, localStats);
        // The clone-only Bind is reflected by the tooltip pass. Preserve that generated
        // stats suffix while continuing to inherit the player's description prose.
        const currentDescription = tagValue(current, "Description") ?? "";
        const currentStats = currentDescription.match(/\s*\[Stats:[\s\S]*$/)?.[0];
        const sourceDescription = tagValue(clone, "Description") ?? "";
        if (currentStats) {
          const sourceProse = sourceDescription.replace(/\s*\[Stats:[\s\S]*$/, "");
          clone = replaceTag(clone, "Description", `${sourceProse}${currentStats}`, localStats);
        }
        clone = clone.replace(/(<Description>[^<]*<\/Description>)\r\n/, "$1\n");
        clone = clone.replace(
          /(<UpgradeDescription>Tendril Defense reduction is (?:6|8|10)%\.<\/UpgradeDescription>)\r\n/,
          "$1\n",
        );
      }
      if (definition.clone === "FalseScorpionSting") {
        clone = clone.replace(
          /(<AddTargetBuff>(?:[^<]*,)?)PoisonStrike(?=,|<\/AddTargetBuff>)/,
          "$1ShadowLegionPoisonStrike",
        );
        clone = clone.replace(
          /(<AddTargetBuff>ShadowLegionPoisonStrike[^<]*<\/AddTargetBuff>)\r\n/,
          "$1\n",
        );
      }
      if (clone !== current) {
        patched = patched.replace(current, clone);
        stats.powers += 1;
        stats.changes += 1;
      }
    }
  }
  return patched;
}

export function patchPlayerBuffs(xml: string): { xml: string; stats: Stats } {
  const stats: Stats = { powers: 0, entities: 0, changes: 0 };
  let patched = xml;
  if (!patched.includes('BuffName="ShadowLegionPoisonStrike"')) {
    const poison = patched.match(/<BuffType BuffName="PoisonStrike">[\s\S]*?<\/BuffType>/)?.[0];
    if (!poison) throw new Error("PoisonStrike buff template not found.");
    const clonePoison = poison
      .replace('BuffName="PoisonStrike"', 'BuffName="ShadowLegionPoisonStrike"')
      .replace(/<BuffID>[^<]*<\/BuffID>/, "<BuffID>743</BuffID>")
      .replace(/\r\n/g, "\n");
    const newline = poison.includes("\r\n") ? "\r\n" : "\n";
    patched = patched
      .replace(poison, `${poison}${newline}\t${clonePoison}`)
      .replace(`${clonePoison}\r\n`, `${clonePoison}\n`);
    stats.changes += 1;
  }

  const ids = new Map<string, string>();
  for (const block of patched.match(/<BuffType BuffName="[^"]+">[\s\S]*?<\/BuffType>/g) ?? []) {
    const name = block.match(/<BuffType BuffName="([^"]+)">/)?.[1] ?? "";
    const id = tagValue(block, "BuffID");
    if (!id) continue;
    const prior = ids.get(id);
    if (prior) throw new Error(`Duplicate BuffID ${id}: ${prior} and ${name}`);
    ids.set(id, name);
  }
  return { xml: patched, stats };
}

function validateClonePowerIdentities(xml: string): void {
  const ids = new Map<string, string>();
  for (const block of xml.match(/<Power PowerName="[^"]+">[\s\S]*?<\/Power>/g) ?? []) {
    const powerName = block.match(/<Power PowerName="([^"]+)">/)?.[1] ?? "";
    const powerId = tagValue(block, "PowerID");
    if (powerId) {
      const prior = ids.get(powerId);
      if (prior) throw new Error(`Duplicate PowerID ${powerId}: ${prior} and ${powerName}`);
      ids.set(powerId, powerName);
    }

    const match = powerName.match(/^(False(?:Chi|TendrilDash|ScorpionSting))(?:[1-9]|10)?$/);
    if (!match) continue;
    const basePowerName = tagValue(block, "BasePowerName");
    const expectedBase = match[1];
    if (basePowerName !== expectedBase) {
      throw new Error(`${powerName} must use BasePowerName ${expectedBase}, found ${basePowerName ?? "(missing)"}.`);
    }
  }
}

export function patchPlayerPowers(xml: string): { xml: string; stats: Stats } {
  const stats: Stats = { powers: 0, entities: 0, changes: 0 };
  let patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block, powerName: string) => {
    let next = block;

    if (/^CrippleStrike\d*$/.test(powerName)) {
      const rank = rankOf(powerName, "CrippleStrike");
      next = addBuff(next, "Bound", stats);
      let description = tagValue(next, "Description") ?? "";
      description = description
        .replace(" While Stealthed, adds 60% of Expertise as damage.", "")
        .replace(" Deals 60% of Expertise as bonus damage against Bound targets.", "")
        .replace(" Deals 70% of Expertise as bonus damage against Bound targets.", "")
        .replace(
          "apply Weaken, Cripple and Armor Bane.",
          "apply Bind, Weaken, Cripple and Armor Bane.",
        );
      if (rank >= 2) {
        description = description.replace(
          " [Stats:",
          " Deals 70% of Expertise as bonus damage against Bound targets. [Stats:",
        );
      }
      next = replaceTag(next, "Description", description, stats);
      const upgradeDescription = (tagValue(next, "UpgradeDescription") ?? "").replace(
        "apply Weaken, Cripple and Armor Bane.",
        "apply Bind, Weaken, Cripple and Armor Bane.",
      );
      next = replaceTag(next, "UpgradeDescription", upgradeDescription, stats);
      if (powerName === "CrippleStrike2") {
        next = replaceTag(
          next,
          "UpgradeDescription",
          "Deals 70% of Expertise as bonus damage against Bound targets. Increased Damage #olddmg#",
          stats,
        );
      }
    }

    if (/^WhitheringMist\d*$/.test(powerName)) {
      const rank = rankOf(powerName, "WhitheringMist");
      next = addBuff(next, "Bound", stats);
      let description = tagValue(next, "Description") ?? "";
      description = description
        .replace(" While Stealthed, adds 40% of Expertise as damage.", "")
        .replace(" Deals 40% of Expertise as bonus damage against Bound targets.", "")
        .replace(" Deals 30% of Expertise as bonus damage against Bound targets.", "")
        .replace("Weakens and Blinds your foes.", "Weakens, Blinds and Binds your foes.")
        .replace("Weakens your foes.", "Weakens and Binds your foes.");
      if (rank >= 3) {
        description = description.replace(
          " [Stats:",
          " Deals 30% of Expertise as bonus damage against Bound targets. [Stats:",
        );
      }
      next = replaceTag(next, "Description", description, stats);
      const upgradeDescription = (tagValue(next, "UpgradeDescription") ?? "")
        .replace("Weakens and Blinds your foes.", "Weakens, Blinds and Binds your foes.")
        .replace("Weakens your foes.", "Weakens and Binds your foes.");
      next = replaceTag(next, "UpgradeDescription", upgradeDescription, stats);
      if (powerName === "WhitheringMist3") {
        next = replaceTag(
          next,
          "UpgradeDescription",
          "Deals 30% of Expertise as bonus damage against Bound targets. Increased Damage #olddmg#",
          stats,
        );
      }
    }

    if (/^DarkChi\d*$/.test(powerName)) {
      next = upsertAfter(next, "Range", "AoERadius", "50", stats);
    }

    if (/^ShadowLegion\d*$/.test(powerName)) {
      next = replaceTag(next, "SpawnDuration", "12000", stats);
      const rank = rankOf(powerName, "ShadowLegion");
      const cloneRank = Math.max(1, rank);
      const description = "Summon three Shadow Clones for 12 seconds. Clones use your Scorpion Sting, Dark Chi and Black Miasma ranks, generate +50% Hate, and Bind with their special attacks.";
      next = replaceTag(next, "Description", description, stats);
      next = next.replace(`<Description>${description}</Description>\r\n`, `<Description>${description}</Description>\n`);
      next = replaceTag(next, "SpawnedMonsters", `ShadowLegionClone${cloneRank},ShadowLegionCloneTwo${cloneRank},ShadowLegionCloneThree${cloneRank}`, stats);
      next = replaceTag(next, "SpawnLimit", "3", stats);
      if (rank === 10) {
        next = replaceTag(next, "UpgradeDescription", "Clone explosion deals +10% Damage and Blinds targets.", stats);
      }
    }

    if (/^FalseSaberMelee\d*$/.test(powerName)) {
      next = removeBuff(next, "Bound", stats);
      next = replaceTag(next, "AggroBonus", "1.5", stats);
    }

    if (/^False(?:Chi|TendrilDash|ScorpionSting)\d*$/.test(powerName)) {
      next = addBuff(next, "Bound", stats);
      next = replaceTag(next, "AggroBonus", "1.5", stats);
      next = replaceTag(next, "CoolDownTime", "0", stats);
    }

    if (next !== block) stats.powers += 1;
    return next;
  });
  patched = addRankedClonePowers(patched, stats);
  patched = addRankedScorpionPowers(patched, stats);
  patched = syncClonePowers(patched, stats);
  validateClonePowerIdentities(patched);
  return { xml: patched, stats };
}

export function patchEntTypes(xml: string): { xml: string; stats: Stats } {
  const stats: Stats = { powers: 0, entities: 0, changes: 0 };
  let patched = xml.replace(
    /<EntType EntName="(ShadowLegionClone(?:Two|Three)?(\d+))"[\s\S]*?<\/EntType>/g,
    (block, _name: string, rankText: string) => {
      const rank = Math.max(1, Math.min(10, Number(rankText) || 1));
      let next = replaceTag(block, "HitPoints", String(cloneHp[rank]), stats);
      next = replaceTag(next, "ArmorClass", String(cloneDefense[rank]), stats);
      if (next !== block) stats.entities += 1;
      return next;
    },
  );

  for (let rank = 1; rank <= 10; rank += 1) {
    if (patched.includes(`EntName="ShadowLegionCloneThree${rank}"`)) continue;
    const source = patched.match(new RegExp(`<EntType EntName="ShadowLegionClone${rank}"[\\s\\S]*?<\\/EntType>`))?.[0];
    if (!source) continue;
    const clone = source
      .replace(`EntName="ShadowLegionClone${rank}"`, `EntName="ShadowLegionCloneThree${rank}"`)
      .replace(/<DisplayName>[^<]*<\/DisplayName>/, `<DisplayName>Shadow Legion Clone 3 Rank ${rank}</DisplayName>`);
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    patched = patched.replace(source, `${source}${newline}\t${clone}`);
    stats.entities += 1;
    stats.changes += 1;
  }

  return { xml: patched, stats };
}

function merge(...items: Stats[]): Stats {
  return items.reduce((sum, item) => ({
    powers: sum.powers + item.powers,
    entities: sum.entities + item.entities,
    changes: sum.changes + item.changes,
  }), { powers: 0, entities: 0, changes: 0 });
}

function patchFile(filePath: string, patcher: (xml: string) => { xml: string; stats: Stats }, verify: boolean): Stats {
  const original = fs.readFileSync(filePath, "utf8");
  const result = patcher(original);
  if (!verify && result.xml !== original) fs.writeFileSync(filePath, result.xml, "utf8");
  return result.stats;
}

function patchSwz(filePath: string, verify: boolean): Stats {
  const ctx = parseSwz(filePath);
  const results: Stats[] = [];
  let changed = false;
  for (const entry of [
    { marker: "<PlayerPowerTypes", patcher: patchPlayerPowers },
    { marker: "<PlayerBuffTypes", patcher: patchPlayerBuffs },
    { marker: "<EntTypes", patcher: patchEntTypes },
  ]) {
    const chunk = ctx.chunks.find((candidate) => candidate.xml.includes(entry.marker));
    if (!chunk) continue;
    const result = entry.patcher(chunk.xml);
    results.push(result.stats);
    if (result.xml !== chunk.xml) {
      changed = true;
      if (!verify) chunk.xml = result.xml;
    }
  }
  if (!verify && changed) {
    ensureBackup(filePath);
    writeSwz(ctx);
  }
  return merge(...results);
}

export function patchConfiguredShadowstalkerBalance(verify: boolean): Stats {
  // Player powers live in Game.swz, while EntTypes is loaded earlier from Login.swz.
  // Both archives must be patched: referencing a loose-only clone from Game.swz crashes
  // the client as soon as Shadow Legion tries to instantiate the unknown EntType.
  const swzFiles = ["Login.swz", "Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((name) => path.join(CBQ_DIR, name))
    .filter(fs.existsSync);
  return merge(
    patchFile(POWER_XML, patchPlayerPowers, verify),
    patchFile(BUFF_XML, patchPlayerBuffs, verify),
    patchFile(ENT_XML, patchEntTypes, verify),
    ...swzFiles.map((filePath) => patchSwz(filePath, verify)),
  );
}

if (require.main === module) {
  const verify = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  const stats = patchConfiguredShadowstalkerBalance(verify);
  console.log(JSON.stringify({ verify, stats }, null, 2));
  console.log(stats.changes === 0 ? "Shadowstalker balance verified." : verify ? "Patch required." : "Patch applied.");
}
