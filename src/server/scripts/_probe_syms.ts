import * as path from "path";
import { readSwfFile, readSymbolClasses } from "./swfLevelUtils";
const swf = readSwfFile(path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbo", "UI_Seasonal.swf"));
for (const s of readSymbolClasses(swf)) console.log(s.id, s.name);
