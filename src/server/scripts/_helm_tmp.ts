import * as path from "path";
import { readSwfFile, readSymbolClasses, characterBounds } from "./swfLevelUtils";
const dir = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp");
for (const f of ["UI_2.swf", "UI_1.swf", "UI_4.swf"]) {
  const swf = readSwfFile(path.join(dir, f));
  for (const e of readSymbolClasses(swf)) {
    if (!/PumpkinHelm/i.test(e.name)) continue;
    const b = characterBounds(swf, e.id);
    console.log(f, e.id, e.name, b ? `${Math.round((b.xMax-b.xMin)/20)}x${Math.round((b.yMax-b.yMin)/20)}` : "?");
  }
}
