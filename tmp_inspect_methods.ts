import * as swf from './src/server/scripts/swfPatchUtils.ts';

const { parseSwf, parseAbc, classIndexByName, methodIdxForTrait } = swf;
const swfPath = process.argv[2] || 'src/client/content/localhost/p/cbp/DungeonBlitz.swf';
const ctx = parseSwf(swfPath);
const abc = parseAbc(ctx);

function list(className: string) {
  const idx = classIndexByName(abc, className);
  console.log(`${className} idx`, idx);
  if (idx === null) return;
  const traits = abc.instances[idx].traits;
  for (const trait of traits) {
    const name = abc.multinameNames[trait.nameIdx] ?? `#${trait.nameIdx}`;
    if (trait.methodIdx !== null && name.startsWith('method_')) {
      console.log(`  ${name}: ${trait.methodIdx}`);
    }
  }
}

list('Main');
list('Game');

const mainIdx = classIndexByName(abc, 'Main');
if (mainIdx !== null) {
  const mainMethod = methodIdxForTrait(abc.instances[mainIdx].traits, abc, 'method_561');
  console.log('Main.method_561 methodIdx=', mainMethod);
}
