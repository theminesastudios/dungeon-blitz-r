import * as path from "path";
import {
  readSwfFile,
  characterTagsById,
  readSymbolClasses,
  spriteInnerTags,
  parsePlace,
  characterBounds,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  TAG_REMOVE_OBJECT,
  TAG_START_SOUND,
  TAG_SHOW_FRAME,
  TAG_END,
} from "./swfLevelUtils";

const UI1 = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "UI_1.swf");
const UI2 = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "UI_2.swf");

const swf = readSwfFile(UI1);
const byId = characterTagsById(swf);
const symbols = readSymbolClasses(swf);

const daggerBinding = symbols.find((b) => b.name === "a_PowerIcon_PoisonDagger");
console.log("dagger binding:", daggerBinding);

const tag = daggerBinding ? byId.get(daggerBinding.id) : null;
console.log("dagger tag code:", tag?.code);

if (tag && tag.code === TAG_DEFINE_SPRITE) {
  const inner = spriteInnerTags(tag);
  console.log("inner tag count:", inner.length);
  for (const child of inner) {
    if (child.code === TAG_PLACE_OBJECT2 || child.code === TAG_PLACE_OBJECT3) {
      const place = parsePlace(child);
      console.log(
        `  PO${child.code === TAG_PLACE_OBJECT3 ? 3 : 2} depth=${place.depth} charId=${place.charId} ` +
          `matrix=${place.matrix ? JSON.stringify(place.matrix) : "null"} name=${place.name} move=${place.move}`
      );
    } else if (child.code === TAG_PLACE_OBJECT) {
      console.log(`  PO1 charId=${child.data.readUInt16LE(0)}`);
    } else {
      console.log(`  tag ${child.code} len=${child.data.length}`);
    }
  }
}

const bounds = daggerBinding ? characterBounds(swf, daggerBinding.id) : null;
console.log("dagger bounds (twips):", bounds);

// status icon sizes from UI_2.swf for comparison
const swf2 = readSwfFile(UI2);
const byId2 = characterTagsById(swf2);
for (const b of readSymbolClasses(swf2)) {
  if (b.name.startsWith("a_StatusIcon_")) {
    const bd = characterBounds(swf2, b.id);
    if (bd) {
      console.log(
        `UI_2 ${b.name} id=${b.id} bounds=${JSON.stringify(bd)} px=${((bd.xMax - bd.xMin) / 20).toFixed(1)}x${((bd.yMax - bd.yMin) / 20).toFixed(1)}`
      );
    }
  }
}
