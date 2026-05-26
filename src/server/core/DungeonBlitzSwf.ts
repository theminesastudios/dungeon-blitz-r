import * as fs from 'fs';
import * as zlib from 'zlib';
import {
    applyPatchesToBody,
    classIndexByName,
    disassemble,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    u30OperandName,
    writeU30
} from '../scripts/swfPatchUtils';
import { Config } from './config';

export type DungeonBlitzSwfMode = 'local' | 'multiplayer';
export type DungeonBlitzSwfLocale = 'en' | 'tr' | 'pt-br';

export const SWF_RUNTIME_VERSION = '20260526-ptbr-v55';

const LOCAL_HOST = 'localhost';
const REMOTE_HOST = Config.MULTIPLAYER_HOST;
const LOCAL_ASSET_PATH = ':8000/p/';
const REMOTE_ASSET_PATH = '/p/';
const OLD_LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp';
const OLD_LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp';
const OLD_REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp`;
const OLD_REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp`;
const PREVIOUS_LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbu&gv=cbt';
const PREVIOUS_LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbu&gv=cbt';
const PREVIOUS_REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbu&gv=cbt`;
const PREVIOUS_REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbu&gv=cbt`;
const CURRENT_PREVIOUS_LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbv&gv=cbu';
const CURRENT_PREVIOUS_LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbv&gv=cbu';
const CURRENT_PREVIOUS_REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbv&gv=cbu`;
const CURRENT_PREVIOUS_REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbv&gv=cbu`;
const CURRENT_LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv';
const CURRENT_LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv';
const CURRENT_REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv`;
const CURRENT_REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv`;
const LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw';
const LOCAL_PORTUGUESE_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw&lang=pt-br';
const LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw';
const REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw`;
const REMOTE_PORTUGUESE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw&lang=pt-br`;
const REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw`;
const MOUNT_SPEED_PATCH_CLASS = 'CombatState';
const MOUNT_SPEED_PATCH_METHOD = 'method_960';
const MOUNT_SPEED_DUNGEON_FLAG = 'bInstanced';
const DISCONNECT_REFRESH_BUTTON_X_OFFSET_PX = 3;
const DISCONNECT_REFRESH_BUTTON_Y_OFFSET_PX = -5;
const UI1_DEFINE_EDIT_TEXT_REPLACEMENTS = new Map<number, StringReplacement[]>([
    [2594, [{ oldValue: 'Dungeon', newValue: 'Masmorra' }]]
]);
const UI1_TAG_ONLY_OLDVALUES = new Set([
    'Add Friend',
    'Add Ignored',
    '0 of 0 friends online.',
    'Exit House',
    'Backpack',
    'Talents',
    'Spellbook',
    'Map\u0000',
    'Officer',
    'Guild',
    'Party',
    'Say',
    'Friends',
    'Zone',
    'Ignore',
    'The Black Rose Mire',
    'Black Rose Mire',
    'Pantano da Rosa Negra',
    'Pântano da Rosa Negra'
]);
const UI1_PORTUGUESE_EDIT_TEXT_XMAX = new Map<number, number>([
    [85, 4400],
    // Social panel tabs/buttons.
    [17, 1600],
    [41, 2800],
    [44, 2400],
    // Tutorial reward/item popup title and body. Portuguese strings are wider than
    // the original English text and otherwise get clipped inside the fixed field.
    [179, 6400],
    [180, 8000],
    [431, 3900],
    [439, 4540],
    [482, 8000],
    [485, 6800],
    [493, 7600],
    [556, 8200],
    [558, 7200],
    [560, 7200],
    [625, 5400],
    [1136, 5600],
    [1141, 5600],
    [1271, 3800],
    [1272, 1600],
    [1287, 1600],
    [1288, 2200],
    [1289, 2200],
    [1290, 1700],
    [1291, 3400],
    [1303, 2700],
    [1305, 4680]
]);
const UI1_PORTUGUESE_EDIT_TEXT_BOUNDS = new Map<number, { xmin: number; xmax: number }>([
    [10, { xmin: -160, xmax: 960 }], // Guild tab title.
    [32, { xmin: -1440, xmax: 3800 }], // Guild panel bottom status.
    [431, { xmin: -40, xmax: 3900 }], // New house callout.
    [439, { xmin: 180, xmax: 4532 }], // Hatchery unlocked callout.
    [625, { xmin: -1100, xmax: 5100 }], // Build the Tome of Power callout.
    [1305, { xmin: -180, xmax: 3820 }], // Score screen exit dungeon button.
    [1059, { xmin: -520, xmax: 6680 }] // Map scroll header title.
]);
const UI1_PORTUGUESE_EDIT_TEXT_FONT_HEIGHT = new Map<number, number>([
    [1305, 285] // Keep "Sair da Masmorra" inside the score screen button.
]);
const UI1_PORTUGUESE_SPRITE_PLACEMENT_PATCHES = new Map<number, Map<number, { tx?: number; ty?: number; scaleX?: number }>>([
    [18, new Map([[1, { scaleX: 1.42 }]])], // Ignorados tab background.
    [42, new Map([[2, { ty: 120 }]])], // Add Ignored footer plus icon.
    [43, new Map([[15, { tx: 2860 }]])], // Add Ignored footer action.
    [45, new Map([[2, { ty: 120 }]])], // Add Friend footer plus icon.
    [47, new Map([[1, { tx: 3760 }]])], // Add Friend footer action.
    [434, new Map([[2, { tx: -2300 }]])],
    [626, new Map([[5, { tx: -2700 }]])],
    [1292, new Map([[2, { tx: 3000 }], [3, { tx: 1050 }]])],
    [1304, new Map([[6, { tx: -80 }]])],
    [1306, new Map([[2, { scaleX: 1.74, tx: -260 }], [6, { scaleX: 1, tx: -560, ty: 185 }]])]
]);
const UI4_DEFINE_EDIT_TEXT_REPLACEMENTS = new Map<number, StringReplacement[]>([
    [138, [{ oldValue: 'Welcome to', newValue: 'Bem-vindo ao' }]], // The Spellbook
    [2304, [{ oldValue: 'Welcome to', newValue: 'Bem-vindo ao' }]], // Tome of Training
    [4261, [{ oldValue: 'Hatch Egg', newValue: 'Chocar Ovo' }]]
]);
const UI4_PORTUGUESE_EDIT_TEXT_XMAX = new Map<number, number>([
    [375, 8400], // First crafted charm callout.
    [644, 7600],
    [645, 8200],
    [655, 7600],
    [656, 8200],
    [666, 7600],
    [667, 8200],
    [688, 7600],
    [689, 8200],
    [1001, 7600],
    [1015, 7600],
    [1702, 3200], // Visit House tooltip.
    [2019, 3200], // Exit House tooltip.
    [2023, 4600], // Exit Dungeon tooltip.
    [2027, 3200], // Talents tooltip.
    [2038, 4600], // Spellbook tooltip.
    [2320, 8200],
    [4000, 8200]
]);
const UI4_PORTUGUESE_EDIT_TEXT_BOUNDS = new Map<number, { xmin: number; xmax: number }>([
    [2311, { xmin: -360, xmax: 8525 }], // Tome tutorial first callout line.
    [4328, { xmin: -180, xmax: 4626 }] // Hatchery tutorial first callout line.
]);
const UI4_PORTUGUESE_TOOLTIP_SPRITE_SCALE_X = new Map<number, number>([
    [1703, 1.1], // Visit House.
    [2020, 1.1], // Exit House.
    [2024, 1.24], // Exit Dungeon.
    [2028, 1.08], // Talents.
    [2039, 1.3] // Spellbook.
]);
const UI4_PORTUGUESE_TOOLTIP_BACKGROUND_X_SHIFT_TWIPS = new Map<number, number>([
    [2039, -700] // Spellbook: keep the tooltip clear of the chat overlay.
]);
const UI4_PORTUGUESE_TOOLTIP_TEXT_X_SHIFT_TWIPS = new Map<number, number>([
    [1703, -180], // Visit House.
    [2020, -170], // Exit House.
    [2024, -360], // Exit Dungeon.
    [2028, -230], // Talents.
    [2039, -1060] // Spellbook.
]);
type StringReplacement = {
    oldValue: string;
    newValue: string;
};

type StringInterner = (value: string) => number;

const LANGUAGE_COMMAND_PASSTHROUGH_REPLACEMENTS: StringReplacement[] = [
    { oldValue: '\\lang:tr', newValue: '/lang:ptbr' },
    { oldValue: '\\lang:en', newValue: '/lang:br' }
];

function longestFirstReplacements(replacements: StringReplacement[]): StringReplacement[] {
    return [...replacements].sort((left, right) => right.oldValue.length - left.oldValue.length);
}

function isBrazilianPortugueseMainSwfTextEnabled(): boolean {
    // Broad string replacement in DungeonBlitz.swf can hit internal state keys
    // as well as visible labels. Keep it opt-in for diagnostics only; PT-BR
    // runtime text should live in Game.pt-br.swz, dialogue data, or scoped asset
    // SWF patches where the string is known to be visual.
    return process.env.DB_PTBR_MAIN_SWF_TEXT === '1';
}

function isBrazilianPortugueseEmotePatchEnabled(): boolean {
    return process.env.DB_PTBR_EMOTE_PATCHES !== '0';
}

const TURKISH_DISCIPLINE_REPLACEMENTS: StringReplacement[] = [
    {
        oldValue: 'Blessed by the Storm Gods, you draw enemy wrath upon your impregnable form and focus the tempest until you become the Lightning Avatar and smite all who stand before you.',
        newValue: 'Firtina Tanrilari tarafindan kutsanmis olarak dusmanlarin ofkesini sarsilmaz bedenine cekersin; firtinayi odaklayip Simsek Avatarina donusur, karsina cikan herkesi cezalandirirsin.'
    },
    {
        oldValue: 'With righteous fury from the Flame of Justice coursing through your body, you leap into the fray, a blaze of attacks swirling through the enemy ranks.',
        newValue: 'Adalet Alevi bedeninde dolasan hakli ofkeyle savasa atlarsin; dusman saflarinin icinde alevli saldirilarla donersin.'
    },
    {
        oldValue: 'Infused with the Numinous Essence, you shine a searing, sacred light into the darkest places, healing the worthy and inflicting blinding agony upon the wicked.',
        newValue: 'Numinous Oz ile dolarak en karanlik yerlere yakici kutsal isik sacarsin; layik olanlari iyilestirir, kotulere kor edici aci verirsin.'
    },
    {
        oldValue: 'You have forsaken all safety for the Pure Death; you know the perfect strike, the incurable venom, the hidden cut that dooms your chosen foe to certain annihilation.',
        newValue: 'Saf Olum ugruna tum guvenligi biraktin; kusursuz darbeyi, caresiz zehri ve sectigin dusmani kesin yok olusa goturen gizli kesigi bilirsin.'
    },
    {
        oldValue: 'You have sacrificed yourself to the Shadow Court, becoming a deadly trickster who strikes from afar, appears everywhere at once, and terrorizes enemies from the darkness.',
        newValue: 'Kendini Golge Sarayi\'na adadin; uzaktan vuran, ayni anda her yerde beliren ve karanliktan dusmanlara dehset salan olumcul bir hilekara donustun.'
    },
    {
        oldValue: 'You have mastered the heresies of the Codex Carnifex; you know that true pain comes with the death of the soul and that true victory takes a foe’s life force as your dark reward.',
        newValue: 'Codex Carnifex\'in sapkin ogretilerinde ustalastin; gercek acinin ruhun olumunden geldigini ve gercek zaferin dusmanin yasam gucunu karanlik odul olarak almak oldugunu bilirsin.'
    },
    {
        oldValue: 'Touched by an Essence of Fire, you throw caution to the wind with every explosive inferno you unleash upon the enemy, incinerating all but leaving you vulnerable among the ashes.',
        newValue: 'Ates Ozunun dokundugu biri olarak, saldigin her patlayici cehennemle tedbiri elden birakirsin; dusmani yakip kul eder ama kullerin arasinda savunmasiz kalirsin.'
    },
    {
        oldValue: 'Channeling the Eternal Winter, your icy conjurations keep the enemy hordes at bay and protect you from harm while a frozen doom descends upon all who oppose you.',
        newValue: 'Ebedi Kisi kanalize ederek buzlu yaratilimlarinla dusman surulerini uzakta tutar, sana zarar gelmesini onlersin; karsi koyanlarin uzerine donmus bir son coker.'
    },
    {
        oldValue: 'Tainted by the Curse of Undeath, you fear no foe, raising armies of hungry ghouls to feast upon your unfortunate enemies, your own power and immortal essence grows with every victim they claim.',
        newValue: 'Olumsuzluk Lanetiyle lekelenmis olarak hicbir dusmandan korkmazsin; talihsiz dusmanlarina saldirdigin ac gulyabani ordulari kurarsin ve aldiklari her kurbanla gucun ve olumsuz ozun buyur.'
    },
    { oldValue: 'Wizardry Guild', newValue: 'Buyuculuk Loncasi' },
    { oldValue: 'Winter Order', newValue: 'Kis Tarikati' },
    { oldValue: 'Infernal Circle', newValue: 'Cehennem Cemberi' },
    { oldValue: 'Accursed Coven', newValue: 'Lanetli Meclis' },
    { oldValue: 'Tricks o’ Trade', newValue: 'Meslegin Hileleri' },
    { oldValue: 'Ambush & Onslaught', newValue: 'Pusu ve Taarruz' },
    { oldValue: 'From the Shadows', newValue: 'Golgelerden' },
    { oldValue: 'The Dark Arts', newValue: 'Kara Sanatlar' },
    { oldValue: 'Martial Techniques', newValue: 'Savas Teknikleri' },
    { oldValue: 'Chivalric Prowess', newValue: 'Sovalye Mahareti' },
    { oldValue: 'Sacred Castigations', newValue: 'Kutsal Cezalar' },
    { oldValue: 'Theurgical Devotions', newValue: 'Ilahi Adanmalar' },
    { oldValue: 'Discipline Masteries', newValue: 'Disiplin Ustaligi' }
];

const BRAZILIAN_PORTUGUESE_DISCIPLINE_REPLACEMENTS: StringReplacement[] = [
    {
        oldValue: 'Blessed by the Storm Gods, you draw enemy wrath upon your impregnable form and focus the tempest until you become the Lightning Avatar and smite all who stand before you.',
        newValue: 'Abencoado pelos Deuses da Tempestade, voce atrai a furia inimiga para seu corpo inabalavel, concentra a tormenta, torna-se o Avatar do Raio e pune todos diante de voce.'
    },
    {
        oldValue: 'With righteous fury from the Flame of Justice coursing through your body, you leap into the fray, a blaze of attacks swirling through the enemy ranks.',
        newValue: 'Com a furia justa da Chama da Justica correndo pelo corpo, voce salta para a batalha e gira em uma sequencia flamejante de ataques entre as fileiras inimigas.'
    },
    {
        oldValue: 'Infused with the Numinous Essence, you shine a searing, sacred light into the darkest places, healing the worthy and inflicting blinding agony upon the wicked.',
        newValue: 'Imbuido da Essencia Numinosa, voce leva uma luz sagrada e ardente aos lugares mais escuros, cura os dignos e inflige agonia cegante aos perversos.'
    },
    {
        oldValue: 'You have forsaken all safety for the Pure Death; you know the perfect strike, the incurable venom, the hidden cut that dooms your chosen foe to certain annihilation.',
        newValue: 'Voce abandonou toda seguranca pela Morte Pura; conhece o golpe perfeito, o veneno incuravel e o corte oculto que condena seu alvo escolhido a aniquilacao certa.'
    },
    {
        oldValue: 'You have sacrificed yourself to the Shadow Court, becoming a deadly trickster who strikes from afar, appears everywhere at once, and terrorizes enemies from the darkness.',
        newValue: 'Voce se sacrificou a Corte das Sombras e se tornou um trapaceiro letal que ataca de longe, aparece em todos os lugares ao mesmo tempo e aterroriza inimigos na escuridao.'
    },
    {
        oldValue: 'You have mastered the heresies of the Codex Carnifex; you know that true pain comes with the death of the soul and that true victory takes a foe’s life force as your dark reward.',
        newValue: 'Voce dominou as heresias do Codex Carnifex; sabe que a dor verdadeira vem da morte da alma e que a vitoria verdadeira toma a forca vital do inimigo como recompensa sombria.'
    },
    {
        oldValue: 'Touched by an Essence of Fire, you throw caution to the wind with every explosive inferno you unleash upon the enemy, incinerating all but leaving you vulnerable among the ashes.',
        newValue: 'Tocado por uma Essencia de Fogo, voce abandona a cautela a cada inferno explosivo lancado contra o inimigo, incinera tudo e fica vulneravel entre as cinzas.'
    },
    {
        oldValue: 'Channeling the Eternal Winter, your icy conjurations keep the enemy hordes at bay and protect you from harm while a frozen doom descends upon all who oppose you.',
        newValue: 'Canalizando o Inverno Eterno, suas conjuracoes gelidas mantem as hordas inimigas afastadas e o protegem do perigo enquanto um destino congelado cai sobre quem se opoe a voce.'
    },
    {
        oldValue: 'Tainted by the Curse of Undeath, you fear no foe, raising armies of hungry ghouls to feast upon your unfortunate enemies, your own power and immortal essence grows with every victim they claim.',
        newValue: 'Marcado pela Maldicao da Nao Morte, voce nao teme inimigo algum e ergue exercitos de carniceiros famintos; sua forca e essencia imortal crescem a cada vitima tomada por eles.'
    },
    { oldValue: 'Wizardry Guild', newValue: 'Guilda da Feiticaria' },
    { oldValue: 'Winter Order', newValue: 'Ordem do Inverno' },
    { oldValue: 'Infernal Circle', newValue: 'Circulo Infernal' },
    { oldValue: 'Accursed Coven', newValue: 'Conclave Amaldicoado' },
    { oldValue: 'Tricks o’ Trade', newValue: 'Truques do Oficio' },
    { oldValue: 'Ambush & Onslaught', newValue: 'Emboscada e Investida' },
    { oldValue: 'From the Shadows', newValue: 'Das Sombras' },
    { oldValue: 'The Dark Arts', newValue: 'Artes Sombrias' },
    { oldValue: 'Martial Techniques', newValue: 'Tecnicas Marciais' },
    { oldValue: 'Chivalric Prowess', newValue: 'Proeza Cavalheiresca' },
    { oldValue: 'Sacred Castigations', newValue: 'Castigos Sagrados' },
    { oldValue: 'Theurgical Devotions', newValue: 'Devocoes Teurgicas' },
    { oldValue: 'Discipline Masteries', newValue: 'Maestrias de Disciplina' },
    { oldValue: 'Captain Fink', newValue: 'Capitão Fink' },
    { oldValue: 'Mayor Ristas', newValue: 'Prefeito Ristas' },
    { oldValue: 'No Quests Available', newValue: 'Não há missões disponíveis' },
    { oldValue: 'Quest Available\nTalk to ', newValue: 'Missão Disponível\nFale com ' },
    { oldValue: 'Quest Available\nHead to ', newValue: 'Missão Disponível\nVá para ' },
    { oldValue: 'Quest Available', newValue: 'Missão Disponível' },
    { oldValue: 'Quest Completed', newValue: 'Missão Concluída' },
    { oldValue: 'Quest Complete', newValue: 'Missão Completa' },
    { oldValue: 'New Quest', newValue: 'Nova Missão' },
    { oldValue: 'Learn quest information', newValue: 'Detalhes da próxima missão' },
    { oldValue: 'Complete your first quest', newValue: 'Conclua a primeira missão' },
    { oldValue: 'Complete your next quest', newValue: 'Conclua a próxima missão' },
    { oldValue: 'Accept your next quest', newValue: 'Aceite a próxima missão' },
    { oldValue: 'Click on Anna to accept your quest', newValue: 'Clique na Anna para aceitar a missão' },
    { oldValue: 'Click on Captain Fink to get your reward', newValue: 'Clique no Capitão Fink para receber' },
    { oldValue: 'Click on Captain Fink to accept your quest', newValue: 'Clique no Capitão Fink para aceitar' },
    { oldValue: 'Click on Mayor Ristas to turn in the quest', newValue: 'Clique no Prefeito Ristas para entregar' },
    { oldValue: 'Click on Mayor Ristas to accept your quest', newValue: 'Clique no Prefeito Ristas para aceitar' },
    { oldValue: 'Click on Captain Fink to hear more about your quest', newValue: 'Clique no Capitão Fink para saber mais da missão' },
    { oldValue: 'Click on Mayor Ristas to hear more about your quest', newValue: 'Clique no Prefeito Ristas para saber mais da missão' },
    { oldValue: 'Talk to Captain Fink', newValue: 'Fale com o Capitão Fink' },
    { oldValue: 'Talk to Mayor Ristas', newValue: 'Fale com o Prefeito Ristas' },
    { oldValue: 'Clear the Dungeon', newValue: 'Limpe a Masmorra' },
    { oldValue: 'Travel to', newValue: 'Viajar para' },
    { oldValue: "<font color='#00CCFF'>Dungeon: ", newValue: "<font color='#00CCFF'>Masmorra: " },
    { oldValue: 'Dungeon: ', newValue: 'Masmorra: ' },
    { oldValue: 'Dungeon Level: ', newValue: 'Nível da Masmorra: ' },
    { oldValue: ' ft', newValue: ' m' },
    { oldValue: 'Lost at Sea', newValue: 'Perdidos no Mar' },
    { oldValue: 'Lost At Sea', newValue: 'Perdidos no Mar' },
    { oldValue: 'Colossal War Kraken', newValue: 'Kraken Colossal de Guerra' },
    { oldValue: 'Old Man', newValue: 'Velho' },
    { oldValue: 'Welcome to ', newValue: 'Bem-vindo a ' },
    { oldValue: 'Welcome to', newValue: 'Bem-vindo a' },
    { oldValue: "Fink's Trusty Map", newValue: 'Mapa Confiável de Fink' },
    { oldValue: 'Use this map to help guide you in questing.', newValue: 'Use este mapa para se orientar.' },
    { oldValue: 'Captain Fink gives you his map', newValue: 'Capitão Fink te entrega o mapa.' },
    { oldValue: 'Click the quest tracker to open your new map', newValue: 'Clique no guia de missão para abrir seu mapa' },
    { oldValue: 'Breakable Objects', newValue: 'Objetos Quebráveis' },
    { oldValue: '-Some objects can be broken', newValue: '-Alguns objetos podem quebrar' },
    { oldValue: '-This is done by attacking close up', newValue: '-Para quebrar, ataque de perto' },
    { oldValue: 'Abilities and Mana', newValue: 'Habilidades e Mana' },
    { oldValue: '-Basic attacks fill your mana bar', newValue: '-Ataques básicos enchem sua Mana' },
    { oldValue: '-Stronger abilities cost more mana', newValue: '-Habilidades fortes custam mais Mana' },
    { oldValue: 'Abilities', newValue: 'Habilidades' },
    { oldValue: '-Press the 1, 2, 3 keys to use Abilities', newValue: '-Pressione 1, 2 e 3 para usar habilidades' },
    { oldValue: 'Attack 3 times in a row for Combos', newValue: 'Ataque 3 vezes seguidas: Combo!' },
    { oldValue: 'You gain Mana when you hit monsters', newValue: 'Você ganha Mana ao acertar monstros' },
    { oldValue: 'It costs Mana to use Abilities', newValue: 'Habilidades consomem Mana' },
    { oldValue: 'Jumping', newValue: 'Saltar' },
    { oldValue: '-You can Jump with W, Up, or Space', newValue: '-Pule com W, Cima ou Espaço' },
    { oldValue: 'Dropping', newValue: 'Descer' },
    { oldValue: '-Use S or Down to drop through ledges', newValue: '-Use S ou Baixo para descer plataformas' },
    { oldValue: 'Doors', newValue: 'Portas' },
    { oldValue: '-Click on a door or press E to Enter it', newValue: '-Clique ou aperte E para entrar' },
    { oldValue: 'Camera Bumping', newValue: 'Câmera' },
    { oldValue: '-Mouse to the left edge of the screen to', newValue: '-Leve o mouse até a borda da tela' },
    { oldValue: '-Pan over and see the off-screen enemy', newValue: '-para ver inimigos fora da tela' },
    { oldValue: 'Emotes and Chat Options', newValue: 'Emotes e Chat' },
    { oldValue: '-Click this button for a list of Chat Commands', newValue: '-Clique para ver comandos do chat' },
    { oldValue: '-At the bottom is a list of Emotes', newValue: '-Emotes aparecem no fim da lista' },
    { oldValue: '-Type the command or click it to use', newValue: '-Digite ou clique para usar' },
    { oldValue: '/invite <who>', newValue: '/conv <player>' },
    { oldValue: '/join <who>', newValue: '/entrar <player>' },
    { oldValue: '/friend <who>', newValue: '/amigo <player>' },
    { oldValue: '/tell <who>', newValue: '/msg <player>' },
    { oldValue: '/ignore <who>', newValue: '/ign <player>' },
    { oldValue: '/invite ', newValue: '/conv ' },
    { oldValue: '/join ', newValue: '/entrar ' },
    { oldValue: '/friend ', newValue: '/amigo ' },
    { oldValue: '/tell ', newValue: '/msg ' },
    { oldValue: '/ignore ', newValue: '/ign ' },
    { oldValue: '/leave', newValue: '/sair' },
    { oldValue: 'Invite...', newValue: 'Convidar...' },
    { oldValue: 'Join...', newValue: 'Entrar...' },
    { oldValue: 'Friend...', newValue: 'Amigo...' },
    { oldValue: 'Tell...', newValue: 'Sussurrar...' },
    { oldValue: 'Reply...', newValue: 'Responder...' },
    { oldValue: 'Leave your party', newValue: 'Sair do grupo' },
    { oldValue: 'Ignore...', newValue: 'Ignorar...' },
    { oldValue: 'Chat shortcut:', newValue: 'Atalho do chat:' },
    { oldValue: 'Hit [Enter] to begin', newValue: 'Pressione [Enter] para começar' },
    { oldValue: 'Hit [Enter] to send', newValue: 'Pressione [Enter] para enviar' },
    { oldValue: 'Home and Hearth', newValue: 'Um Novo Lar' },
    { oldValue: 'This house is yours to keep!', newValue: 'Essa casa é toda sua!' },
    { oldValue: 'Click the house icon to visit anytime.', newValue: 'Use o ícone da casa para visitar.' },
    { oldValue: 'Your new house is Unlocked', newValue: 'Sua casa está pronta' },
    { oldValue: 'Build the Barn', newValue: 'Construa a Incubadora' },
    { oldValue: 'Build the Forge', newValue: 'Construa a Forja' },
    { oldValue: 'Build the Tome of Power', newValue: 'Construa o Tomo do Poder' },
    { oldValue: 'Upgrade Building', newValue: 'Melhorar Construção' },
    { oldValue: 'Speed Up', newValue: 'Acelerar' },
    { oldValue: 'Free', newValue: 'Grátis' },
    { oldValue: 'Train', newValue: 'Treinar' },
    { oldValue: 'Tutorial Complete', newValue: 'Tutorial Concluído' },
    { oldValue: 'Leave the Keep', newValue: 'Saia do Forte' },
    { oldValue: 'Select an ability on the left to upgrade', newValue: 'Escolha uma habilidade à esquerda para melhorar' },
    { oldValue: 'Exit Dungeon', newValue: 'Sair da Masmorra' },
    { oldValue: 'Tome of Training', newValue: 'Tomo do Poder' },
    { oldValue: 'Use your Tome of Training to learn new abilities', newValue: 'Use seu Tomo do Poder para aprender novas habilidades' },
    { oldValue: 'Click this ability to get started', newValue: 'Clique nesta habilidade para começar' },
    { oldValue: 'Training abilities takes time and costs gold', newValue: 'Treinar habilidades leva tempo e custa ouro' },
    { oldValue: 'Click "Train" to learn this ability', newValue: 'Clique em "Treinar" para aprender essa habilidade' },
    { oldValue: 'You can speed things up', newValue: 'Você pode agilizar o processo' },
    { oldValue: 'Click "Speed Up" to skip the waiting time', newValue: 'Clique em "Acelerar" para pular a espera' },
    { oldValue: 'Good job! You learned an ability', newValue: 'Muito bem! Você aprendeu uma habilidade' },
    { oldValue: 'Click here to open your Spellbook to equip it', newValue: 'Abra o Livro de Feitiços e equipe-a' },
    { oldValue: 'The Spellbook', newValue: 'Livro de Feitiços' },
    { oldValue: 'Equip abilities from your Spellbook', newValue: 'Equipe habilidades do seu Livro de Feitiços' },
    { oldValue: 'Click this ability to add it to the hotbar', newValue: 'Clique nesta habilidade para colocá-la na barra' },
    { oldValue: 'Is this a Forge? Perhaps when I\'m more experienced...', newValue: 'Isso é uma forja? Talvez quando eu tiver mais experiência...' },
    { oldValue: 'This looks interesting. Perhaps when I\'m more experienced...', newValue: 'Isso parece interessante. Talvez quando eu tiver mais experiência...' },
    { oldValue: 'Wow! My very own barn. Perhaps when I\'m more experienced...', newValue: 'Uau! Minha própria incubadora. Talvez quando eu tiver mais experiência...' },
    { oldValue: 'Welcome, warrior. Enjoy the Guild Hall.', newValue: 'Seja bem-vindo,|bem-vinda, guerreiro.|guerreira. Aproveite o Sal\u00e3o da Guilda.' },
    { oldValue: 'My job is to look after these fine creatures.', newValue: 'Meu trabalho \u00e9 cuidar dessas belas criaturas.' },
    { oldValue: 'Please hatch more eggs, friend. Yval here might like a bit more company.', newValue: 'Por favor, choque mais ovos, amigo.|amiga. O Yval talvez queira mais companhia.' },
    { oldValue: 'Yep.', newValue: 'Sim.' },
    { oldValue: 'Maybe that old man knows how to open this...', newValue: 'Talvez o zelador saiba como abrir isso...' },
    { oldValue: 'The Hatchery is Unlocked', newValue: 'A incubadora foi liberada' },
    { oldValue: 'Magic Forge Unlocked', newValue: 'A forja mágica foi liberada' },
    { oldValue: 'Discipline Towers Unlocked', newValue: 'Torres de Disciplina liberadas' },
    { oldValue: 'Build the Tower', newValue: 'Construa a Torre' },
    { oldValue: 'Moving', newValue: 'Movimento' },
    { oldValue: 'Use W,A,S,D keys to move around', newValue: 'Use W,A,S,D para se mover' },
    { oldValue: 'Health Bar', newValue: 'Barra de Vida' },
    { oldValue: 'If your health reaches zero you die', newValue: 'Se a vida zerar, você morre' },
    { oldValue: '-Pick up red health balls to heal up', newValue: '-Orbes vermelhos curam' },
    { oldValue: 'Pick up red health balls to heal', newValue: 'Orbes vermelhos curam' },
    { oldValue: 'Melee Attacks', newValue: 'Ataques Corpo a Corpo' },
    { oldValue: 'To melee, approach a monster', newValue: 'Aproxime-se do monstro para lutar' },
    { oldValue: 'Hold the left mouse button to swing', newValue: 'Segure o botão para atacar' },
    {
        oldValue: 'Click quest icons to see further details in your tracker',
        newValue: 'Clique nos ícones das missões para ver detalhes'
    },
    { oldValue: 'Ranged Attacks', newValue: 'Ataques à distância' },
    {
        oldValue: 'Mouse over foes that are too far away',
        newValue: 'Passe o mouse em inimigos distantes'
    },
    { oldValue: 'Hold the left mouse button to shoot', newValue: 'Clique e segure para atirar' },
    { oldValue: 'Baglanti Koptu', newValue: 'Conexão Perdida' },
    { oldValue: 'Connection to the\nserver has been lost!', newValue: 'A conexão com o\nservidor foi perdida!' },
    { oldValue: 'Istemci Hatasi', newValue: 'Erro do Cliente' },
    { oldValue: 'How embarrassing,\nI swear this never happens!', newValue: 'Que vergonha,\njuro que isso nunca acontece!' },
    { oldValue: 'Refresh', newValue: 'Atualizar' },
    { oldValue: 'Lost Focus!', newValue: 'Foco Perdido!' },
    { oldValue: 'Click in game to regain focus', newValue: 'Clique no jogo para recuperar o foco' },
    { oldValue: 'Switch Character', newValue: 'Trocar Personagem' },
    { oldValue: 'New Character', newValue: 'Novo Personagem' },
    { oldValue: 'Enter Game', newValue: 'Entrar no Jogo' },
    { oldValue: 'Not My Account', newValue: 'Não é Minha Conta' },
    { oldValue: 'News', newValue: 'Notícias' },
    { oldValue: 'Forums', newValue: 'Fóruns' },
    { oldValue: 'About', newValue: 'Sobre' },
    { oldValue: 'Contact', newValue: 'Contato' },
    { oldValue: 'UI_1.swf', newValue: `UI_1.swf?rv=${SWF_RUNTIME_VERSION}` },
    { oldValue: 'LevelsNR.swf', newValue: `LevelsNR.swf?rv=${SWF_RUNTIME_VERSION}` },
    { oldValue: 'LevelsTut.swf', newValue: `LevelsTut.swf?rv=${SWF_RUNTIME_VERSION}` },
];

export const BRAZILIAN_PORTUGUESE_ASSET_REPLACEMENTS: StringReplacement[] = [
    ...BRAZILIAN_PORTUGUESE_DISCIPLINE_REPLACEMENTS
];

export const BRAZILIAN_PORTUGUESE_UI1_REPLACEMENTS: StringReplacement[] = [
    ...BRAZILIAN_PORTUGUESE_ASSET_REPLACEMENTS,
    { oldValue: 'KILLS', newValue: 'ABATES' },
    { oldValue: 'TREASURE', newValue: 'TESOUROS' },
    { oldValue: 'ACCURACY', newValue: 'PRECISÃO' },
    { oldValue: 'DEATHS', newValue: 'MORTES' },
    { oldValue: 'TIME BONUS', newValue: 'BÔNUS DE TEMPO' },
    { oldValue: 'TOTAL SCORE', newValue: 'PONTUAÇÃO TOTAL' },
    { oldValue: 'View Ranks', newValue: 'Ver Ranques' },
    { oldValue: 'RANK', newValue: 'RANQUE' },
    { oldValue: 'New Quest Item', newValue: 'Novo Item de Missão' },
    { oldValue: 'Add Friend', newValue: 'Adicionar Amigo' },
    { oldValue: 'Add Ignored', newValue: 'Adicionar aos Ignorados' },
    { oldValue: '0 of 0 friends online.', newValue: '0 de 0 amigos online.' },
    { oldValue: 'You have been defeated!', newValue: 'Você foi derrotado!' },
    { oldValue: 'REVIVE', newValue: 'REVIVER' },
    { oldValue: 'Exit House', newValue: 'Sair da Casa' },
    { oldValue: 'Backpack', newValue: 'Mochila' },
    { oldValue: 'Talents', newValue: 'Talentos' },
    { oldValue: 'Spellbook', newValue: 'Livro de Feitiços' },
    { oldValue: 'Map\u0000', newValue: 'Mapa\u0000' },
    { oldValue: 'Officer', newValue: 'Oficiais' },
    { oldValue: 'Guild', newValue: 'Guilda' },
    { oldValue: 'Party', newValue: 'Grupo' },
    { oldValue: 'Say', newValue: 'Local' },
    { oldValue: 'Friends', newValue: 'Amigos' },
    { oldValue: 'Zone', newValue: 'Zona' },
    { oldValue: 'Ignore', newValue: 'Ignorados' },
    { oldValue: 'The Black Rose Mire', newValue: 'Pântano da Rosa Negra' },
    { oldValue: 'Black Rose Mire', newValue: 'Pântano da Rosa Negra' },
    { oldValue: 'Pantano da Rosa Negra', newValue: 'Pântano da Rosa Negra' },
    { oldValue: 'Pântano da Rosa Negra', newValue: 'Pântano da Rosa Negra' }
];

export const BRAZILIAN_PORTUGUESE_UI4_REPLACEMENTS: StringReplacement[] = [
    { oldValue: 'Exit House', newValue: 'Sair da Casa' },
    { oldValue: 'Visit House', newValue: 'Visitar Casa' },
    { oldValue: 'Backpack', newValue: 'Mochila' },
    { oldValue: 'Talents', newValue: 'Talentos' },
    { oldValue: 'Spellbook', newValue: 'Livro de Feitiços' },
    { oldValue: 'Map', newValue: 'Mapa' },
    { oldValue: 'Upgrade Building', newValue: 'Melhorar Construção' },
    { oldValue: 'Speed Up', newValue: 'Acelerar' },
    { oldValue: 'Free', newValue: 'Grátis' },
    { oldValue: 'Train', newValue: 'Treinar' },
    { oldValue: 'Exit Dungeon', newValue: 'Sair da Masmorra' },
    { oldValue: 'Tome of Training', newValue: 'Tomo do Poder' },
    { oldValue: 'Use your Tome of Training to learn new abilities', newValue: 'Use o Tomo do Poder para aprender habilidades' },
    { oldValue: 'Click this ability to get started', newValue: 'Clique nesta habilidade para começar' },
    { oldValue: 'Training abilities takes time and costs gold', newValue: 'Treinar leva tempo e custa ouro' },
    { oldValue: 'Click "Train" to learn this ability', newValue: 'Clique em "Treinar" para aprender' },
    { oldValue: 'You can speed things up', newValue: 'Você pode agilizar o processo' },
    { oldValue: 'Click "Speed Up" to skip the waiting time', newValue: 'Clique em "Acelerar" para pular a espera' },
    { oldValue: 'Good job! You learned an ability', newValue: 'Muito bem! Habilidade aprendida' },
    { oldValue: 'Click here to open your Spellbook to equip it', newValue: 'Abra o Livro de Feitiços e equipe-a' },
    { oldValue: 'The Spellbook', newValue: 'Livro de Feitiços' },
    { oldValue: 'Equip abilities from your Spellbook', newValue: 'Equipe habilidades do Livro' },
    { oldValue: 'Click this ability to add it to the hotbar', newValue: 'Clique nela para pôr na barra' },
    { oldValue: 'Are you sure you want to cancel?', newValue: 'Tem certeza de que deseja cancelar?' },
    { oldValue: 'Yes\u0000', newValue: 'Sim\u0000' },
    { oldValue: 'No\u0000', newValue: 'Não\u0000' },
    { oldValue: 'Tutorial Complete', newValue: 'Tutorial Concluído' },
    { oldValue: 'Leave the Keep', newValue: 'Saia do Forte' },
    { oldValue: 'The Hatchery', newValue: 'Incubadora' },
    { oldValue: 'The Magic Forge', newValue: 'Forja Mágica' },
    { oldValue: 'Magic Forge', newValue: 'Forja Mágica' },
    { oldValue: 'Discipline Towers', newValue: 'Torres da Disciplina' },
    { oldValue: 'Talent Trees', newValue: 'Árvores de Talentos' },
    { oldValue: 'Talent Tree', newValue: 'Árvore de Talentos' },
    { oldValue: 'Unspent Talent Points', newValue: 'Pontos de Talento Livres' },
    { oldValue: 'Unspent Talents Points', newValue: 'Pontos de Talento Livres' },
    { oldValue: 'This is your discipline\'s Tower', newValue: 'Esta é a Torre da sua disciplina' },
    { oldValue: 'Use towers to train additional Talent Points', newValue: 'Use torres para treinar Pontos de Talento extras' },
    { oldValue: 'It takes time and cost gold to train talent points', newValue: 'Treinar Pontos leva tempo e custa ouro' },
    { oldValue: 'It takes time and costs gold to train talent points', newValue: 'Treinar Pontos leva tempo e custa ouro' },
    { oldValue: '- Click "Train Talent Point" to get', newValue: '- Clique em "Treinar Talento" para começar' },
    { oldValue: '- Click "Train Talent Point" to get started', newValue: '- Clique em "Treinar Talento" para começar' },
    { oldValue: 'Click below to train additional Talent Points', newValue: 'Clique abaixo para treinar Pontos de Talento extras' },
    { oldValue: 'Train Talent Point', newValue: 'Treinar Talento' },
    { oldValue: 'Treinar Talent Point', newValue: 'Treinar Talento' },
    { oldValue: 'Good job! You trained a Talent Poin', newValue: 'Muito bem! Você treinou um Ponto' },
    { oldValue: 'Good job! You trained a Talent Point', newValue: 'Muito bem! Você treinou um Ponto' },
    { oldValue: '- Click here to open your Talent Tree', newValue: '- Clique aqui para abrir seus Talentos' },
    { oldValue: 'This is your discipline\'s Talent Tree', newValue: 'Essa é sua Árvore de Talentos atual' },
    { oldValue: '- Level up to earn talent points to customize \r   and improve your character', newValue: '- Suba de nível para ganhar pontos\r  e melhorar seu personagem' },
    { oldValue: '- Level up to earn talent points to customize  \r   and improve your character', newValue: '- Suba de nível para ganhar pontos\r  e melhorar seu personagem' },
    { oldValue: '- Level up to earn talent points to customize  \r  and improve your character', newValue: '- Suba de nível para ganhar pontos\r  e melhorar seu personagem' },
    { oldValue: 'Level up to earn talent points to customize\nand improve your character', newValue: 'Suba de nível para ganhar pontos e\nmelhorar seu personagem' },
    { oldValue: 'Level up to earn talent points to customize  \r  and improve your character', newValue: 'Suba de nível para ganhar pontos e\rmelhorar seu personagem' },
    { oldValue: 'These are your unspent Talent Points', newValue: 'Estes são Pontos de Talento Livres' },
    { oldValue: '- You can gain Talent Points by leveling up or \r   training them at your Discipline Tower', newValue: '- Ganhe Pontos subindo de nível\r  ou treinando na Torre de Disciplina' },
    { oldValue: '- You can gain Talent Points by leveling up or  \r   training them at your Discipline Tower', newValue: '- Ganhe Pontos subindo de nível\r  ou treinando na Torre de Disciplina' },
    { oldValue: '- You can gain Talent Points by leveling up or  \r  training them at your Discipline Tower', newValue: '- Ganhe Pontos subindo de nível\r  ou treinando na Torre de Disciplina' },
    { oldValue: 'You can gain Talent Points by leveling up or\ntraining them at your Discipline Tower', newValue: 'Ganhe pontos subindo de nível ou\ntreinando na sua Torre de Disciplina' },
    { oldValue: 'You can gain Talent Points by leveling up or  \r  training them at your Discipline Tower', newValue: 'Ganhe pontos subindo de nível ou\rtreinando na sua Torre de Disciplina' },
    { oldValue: 'These are Talentstones', newValue: 'Estas são Pedras de Talento' },
    { oldValue: '- Spend Talent Points to socket these stones \r   into your tree to gain power bonuses', newValue: '- Gaste Pontos para encaixar pedras\r  na árvore e ganhar bônus de poder' },
    { oldValue: '- Spend Talent Points to socket these stones  \r   into your tree to gain power bonuses', newValue: '- Gaste Pontos para encaixar pedras\r  na árvore e ganhar bônus de poder' },
    { oldValue: '- Spend Talent Points to socket these stones  \r  into your tree to gain power bonuses', newValue: '- Gaste Pontos para encaixar pedras\r  na árvore e ganhar bônus de poder' },
    { oldValue: 'Spend Talent Points to socket these stones\ninto your tree to gain power bonuses', newValue: 'Gaste pontos para encaixar pedras\nna árvore e ganhar bônus de poder' },
    { oldValue: 'Spend Talent Points to socket these stones  \r  into your tree to gain power bonuses', newValue: 'Gaste pontos para encaixar pedras\rna árvore e ganhar bônus de poder' },
    { oldValue: 'Click a stone to select it', newValue: 'Clique em uma pedra para selecioná-la' },
    { oldValue: 'Certain sockets can upgrade more than others', newValue: 'Alguns encaixes aceitam mais níveis' },
    { oldValue: 'Choose a socket to place the selected Talentstone', newValue: 'Escolha um encaixe para a Pedra selecionada' },
    { oldValue: 'Decisions are not final until you apply them', newValue: 'As escolhas só valem ao aplicar' },
    { oldValue: '- Click "Apply" if you are happy with your choice or \r   "Undo" to make a different one.', newValue: '- Clique em "Aplicar" se gostou da escolha\r  ou "Desfazer" para escolher outra.' },
    { oldValue: '- Click "Apply" if you are happy with your choice or  \r   "Undo" to make a different one.', newValue: '- Clique em "Aplicar" se gostou da escolha\r  ou "Desfazer" para escolher outra.' },
    { oldValue: '- Click "Apply" if you are happy with your choice or  \r  "Undo" to make a different one.', newValue: '- Clique em "Aplicar" se gostou da escolha\r  ou "Desfazer" para escolher outra.' },
    { oldValue: 'Click "Apply" if you are happy with your choice or\n"Undo" to make a different one.', newValue: 'Clique em "Aplicar" se gostou da escolha ou\n"Desfazer" para escolher outra.' },
    { oldValue: 'Click "Apply" if you are happy with your choice or  \r  "Undo" to make a different one.', newValue: 'Clique em "Aplicar" se gostou da escolha ou\r"Desfazer" para escolher outra.' },
    { oldValue: 'Apply', newValue: 'Aplicar' },
    { oldValue: 'Undo', newValue: 'Desfazer' },
    { oldValue: 'Hatch eggs to obtain pets', newValue: 'Choque ovos e ganhe pets' },
    { oldValue: '- Click this egg to get started', newValue: '- Clique no ovo para iniciar' },
    { oldValue: 'It takes time to hatch an egg', newValue: 'Ovo leva tempo para chocar' },
    { oldValue: '- Click "Hatch Egg" to begin hatching', newValue: '- Clique em "Chocar Ovo"' },
    { oldValue: 'Hatch Egg', newValue: 'Chocar Ovo' },
    { oldValue: 'Build the Forge', newValue: 'Construa a Forja' },
    { oldValue: 'Craft charms here in your forge', newValue: 'Crie gemas na sua forja' },
    { oldValue: '- Click this recipe to get started', newValue: '- Clique nesta receita para começar' },
    { oldValue: 'This is the recipe you are going to craft', newValue: 'Esta é a receita que você vai preparar' },
    { oldValue: '- You can use up to 6 materials when crafting', newValue: '- Use até 6 materiais na criação' },
    { oldValue: 'These are your crafting materials', newValue: 'Estes são seus materiais' },
    { oldValue: '- Click this material to craft with it', newValue: '- Clique no material para usá-lo' },
    { oldValue: 'These are material pools', newValue: 'Estes são grupos de materiais' },
    {
        oldValue: '- Add crafting materials to these pools to increase\nthe chances of crafting rare or legendary charms',
        newValue: '- Adicione materiais aos grupos para criar\ngemas raras ou lendárias com mais chance'
    },
    {
        oldValue: '- Add crafting materials to these pools to increase  \r  the chances of crafting rare or legendary charms',
        newValue: '- Adicione materiais aos grupos para criar\ngemas raras ou lendárias com mais chance'
    },
    { oldValue: 'It takes time to craft a charm', newValue: 'Criar uma gema leva tempo' },
    { oldValue: '- Click "Craft Charm" to start crafting your charm', newValue: '- Clique em "Criar Gema" para começar' },
    { oldValue: 'Craft Charm', newValue: 'Criar Gema' },
    { oldValue: 'Good job! You crafted your first charm', newValue: 'Parabéns! Você criou sua primeira gema' },
    { oldValue: '- Socket charms into your gear to gain their bonuses', newValue: '- Equipe gemas no equipamento para ganhar bônus' },
    { oldValue: '- Click "Take Charm" to put this charm in your backpack', newValue: '- Clique em "Pegar Gema" para guardar na mochila' },
    { oldValue: 'Take Charm', newValue: 'Pegar Gema' },
    { oldValue: 'Charm', newValue: 'Gema' },
    { oldValue: 'Next', newValue: 'Próximo' },
    { oldValue: 'Welcome to', newValue: 'Bem-vindo à' }
];

export const BRAZILIAN_PORTUGUESE_LEVELS_HOME_TEXT_REPLACEMENTS: StringReplacement[] = [
    { oldValue: 'Welcome, warrior. Enjoy the Guild Hall.', newValue: 'Seja bem-vindo,|bem-vinda, guerreiro.|guerreira. Aproveite o Salão da Guilda.' },
    { oldValue: 'My job is to look after these fine creatures.', newValue: 'Meu trabalho é cuidar dessas belas criaturas.' },
    { oldValue: 'Please hatch more eggs, friend. Yval here might like a bit more company.', newValue: 'Por favor, choque mais ovos, amigo.|amiga. O Yval aqui talvez goste de ter um pouco mais de companhia.' },
    { oldValue: 'Come back later and I\'ll tell you how to open these chests!', newValue: 'Volte mais tarde e eu te ensino a abrir esses baús!' },
    {
        oldValue: 'Come back later and I\'ll tell you how to open these chests!=They have all kinds of treasure inside!=I also might sell you some of what I\'ve got in my bag.=Don\'t forget!',
        newValue: 'Volte mais tarde e eu te ensino a abrir esses baús!=Tem todo tipo de tesouro lá dentro!=Talvez eu também venda algumas coisas que tenho na bolsa.=Não esqueça!'
    },
    { oldValue: 'This is your place now.', newValue: 'Este lugar é seu agora.' },
    {
        oldValue: 'This is your place now.=This place has been overrun since the goblins came.=But I bet you can set things right.=That old forge once forged powerful magic items.=It could again.=The tome trained the most powerful heroes of the last age.=But that was then.=I can remember how great this place was once.=There was a fountain of tremendous magic.=And forests full of wild magical animals.=This place could be great again.=This village could thrive again.=If only a hero could lead the way.=Yep.',
        newValue: 'Este lugar é seu agora.=Este lugar está tomado desde que os goblins chegaram.=Mas aposto que você consegue colocar tudo nos eixos.=Aquela velha forja já forjou poderosos itens mágicos.=E pode voltar a forjar.=O tomo treinou os heróis mais poderosos da era passada.=Mas isso ficou no passado.=Eu me lembro de como este lugar já foi grandioso.=Havia uma fonte de magia poderosa.=E florestas repletas de animais mágicos selvagens.=Este lugar pode voltar a ser grandioso.=Esta vila pode voltar a prosperar.=Se ao menos um|uma herói|heroína pudesse nos guiar.=Sim.'
    }
];

export const BRAZILIAN_PORTUGUESE_LEVELS_NR_SCRIPT_REPLACEMENTS: StringReplacement[] = [
    { oldValue: 'Chief Tourzahl', newValue: 'Chefe Tourzahl' },
    { oldValue: "Sythokhan's Dream", newValue: 'Sonho de Sythokahn' },
    { oldValue: "Sythokahn's Dream", newValue: 'Sonho de Sythokahn' },
    { oldValue: 'Sythokhan’s Dream', newValue: 'Sonho de Sythokahn' },
    { oldValue: 'Sythokahn’s Dream', newValue: 'Sonho de Sythokahn' },
    { oldValue: "Nephit is Goblin-kind's salvation!", newValue: 'Nephit é a salvação do povo goblin!' },
    { oldValue: 'He can open the passage!', newValue: 'Ele pode abrir a passagem!' },
    { oldValue: 'No! This is for us!', newValue: 'Não! Isso é nosso!' },
    { oldValue: 'We have to get back to the Sleeping Lands.', newValue: 'Precisamos voltar para as Terras Adormecidas.' },
    { oldValue: 'Nephit Knows.', newValue: 'Nephit sabe.' },
    { oldValue: 'Death is a small price to pay for knowledge.', newValue: 'A morte é um preço pequeno a se pagar pelo conhecimento.' },
    { oldValue: 'So sayeth Nephit', newValue: 'Assim diz Nephit.' },
    { oldValue: 'Bow down to your fate.', newValue: 'Curve-se ao seu destino.' },
    { oldValue: 'Maybe death will take me home...', newValue: 'Talvez a morte me leve para casa...' },
    { oldValue: 'Dead because humans like YOU failed to do your duty when the goblins invaded.', newValue: 'Morto porque humanos como VOCÊ falharam com seu dever quando os goblins invadiram.' },
    { oldValue: 'Yeargh!', newValue: 'Argh!' },
    { oldValue: 'Get back across the sea!', newValue: 'Volte para o outro lado do mar!' },
    { oldValue: 'Get back! Go away!', newValue: 'Afaste-se! Vá embora!' },
    { oldValue: 'He|She found us!', newValue: 'Ele|Ela nos encontrou!' },
    { oldValue: 'He|she found us!', newValue: 'Ele|ela nos encontrou!' },
    { oldValue: 'Intruder!', newValue: 'Intruso|Intrusa!' }
];

const BRAZILIAN_PORTUGUESE_MAIN_SWF_SAFE_REPLACEMENTS: StringReplacement[] = [
    { oldValue: 'Captain Fink', newValue: 'Capitão Fink' },
    { oldValue: 'Mayor Ristas', newValue: 'Prefeito Ristas' },
    { oldValue: 'No Quests Available', newValue: 'Não há missões disponíveis' },
    { oldValue: 'Quest Available\nTalk to ', newValue: 'Missão Disponível\nFale com ' },
    { oldValue: 'Quest Available\nHead to ', newValue: 'Missão Disponível\nVá para ' },
    { oldValue: 'Quest Available', newValue: 'Missão Disponível' },
    { oldValue: 'Quest Completed', newValue: 'Missão Concluída' },
    { oldValue: 'Quest Complete', newValue: 'Missão Completa' },
    { oldValue: 'New Quest', newValue: 'Nova Missão' },
    { oldValue: 'Click on Captain Fink to get your reward', newValue: 'Clique no Capitão Fink para receber' },
    { oldValue: 'Click on Captain Fink to accept your quest', newValue: 'Clique no Capitão Fink para aceitar' },
    { oldValue: 'Click on Mayor Ristas to turn in the quest', newValue: 'Clique no Prefeito Ristas para entregar' },
    { oldValue: 'Click on Mayor Ristas to accept your quest', newValue: 'Clique no Prefeito Ristas para aceitar' },
    { oldValue: 'Click on Anna to accept your quest', newValue: 'Clique na Anna para aceitar a missão' },
    { oldValue: 'Click on Captain Fink to hear more about your quest', newValue: 'Clique no Capitão Fink para saber mais da missão' },
    { oldValue: 'Click on Mayor Ristas to hear more about your quest', newValue: 'Clique no Prefeito Ristas para saber mais da missão' },
    { oldValue: 'Talk to Captain Fink', newValue: 'Fale com o Capitão Fink' },
    { oldValue: 'Talk to Mayor Ristas', newValue: 'Fale com o Prefeito Ristas' },
    { oldValue: 'Dungeon Level: ', newValue: 'Nível da Masmorra: ' },
    { oldValue: 'Clear the Dungeon', newValue: 'Limpe a Masmorra' },
    { oldValue: ' ft', newValue: ' m' },
    { oldValue: 'Welcome to ', newValue: 'Bem-vindo a ' },
    { oldValue: 'Welcome to', newValue: 'Bem-vindo a' },
    { oldValue: '/invite <who>', newValue: '/conv <player>' },
    { oldValue: '/join <who>', newValue: '/entrar <player>' },
    { oldValue: '/friend <who>', newValue: '/amigo <player>' },
    { oldValue: '/tell <who>', newValue: '/msg <player>' },
    { oldValue: '/ignore <who>', newValue: '/ign <player>' },
    { oldValue: '/invite ', newValue: '/conv ' },
    { oldValue: '/join ', newValue: '/entrar ' },
    { oldValue: '/friend ', newValue: '/amigo ' },
    { oldValue: '/tell ', newValue: '/msg ' },
    { oldValue: '/ignore ', newValue: '/ign ' },
    { oldValue: '/leave', newValue: '/sair' },
    { oldValue: 'Invite...', newValue: 'Convidar...' },
    { oldValue: 'Join...', newValue: 'Entrar...' },
    { oldValue: 'Friend...', newValue: 'Amigo...' },
    { oldValue: 'Tell...', newValue: 'Sussurrar...' },
    { oldValue: 'Reply...', newValue: 'Responder...' },
    { oldValue: 'Leave your party', newValue: 'Sair do grupo' },
    { oldValue: 'Ignore...', newValue: 'Ignorar...' },
    { oldValue: 'Chat shortcut:', newValue: 'Atalho do chat:' },
    { oldValue: 'Hit [Enter] to begin', newValue: 'Pressione [Enter] para começar' },
    { oldValue: 'Hit [Enter] to send', newValue: 'Pressione [Enter] para enviar' },
    { oldValue: 'Upgrade Building', newValue: 'Melhorar Construção' },
    { oldValue: 'Build the Forge', newValue: 'Construa a Forja' },
    { oldValue: 'Build the Tome of Power', newValue: 'Construa o Tomo do Poder' },
    { oldValue: 'Speed Up', newValue: 'Acelerar' },
    // NOTE: 'Free' and 'Train' intentionally omitted here.
    // These single-word strings appear as ActionScript identifiers in DungeonBlitz.swf's
    // ABC string pool (e.g. animation states, method names) and replacing them breaks
    // entity state logic, causing animation spam on NewbieRoad in PT-BR.
    // They are safely translated in LevelsNR.swf / LevelsTut.swf / UI_1.swf
    // via BRAZILIAN_PORTUGUESE_DISCIPLINE_REPLACEMENTS (text-tag-level patching only).
    { oldValue: 'Tutorial Complete', newValue: 'Tutorial Concluído' },
    { oldValue: 'Leave the Keep', newValue: 'Saia do Forte' },
    { oldValue: 'Exit Dungeon', newValue: 'Sair da Masmorra' },
    { oldValue: 'Tome of Training', newValue: 'Tomo do Poder' },
    { oldValue: 'Use your Tome of Training to learn new abilities', newValue: 'Use seu Tomo do Poder para aprender novas habilidades' },
    { oldValue: 'Click this ability to get started', newValue: 'Clique nesta habilidade para começar' },
    { oldValue: 'Training abilities takes time and costs gold', newValue: 'Treinar habilidades leva tempo e custa ouro' },
    { oldValue: 'Click "Train" to learn this ability', newValue: 'Clique em "Treinar" para aprender essa habilidade' },
    { oldValue: 'You can speed things up', newValue: 'Você pode agilizar o processo' },
    { oldValue: 'Click "Speed Up" to skip the waiting time', newValue: 'Clique em "Acelerar" para pular a espera' },
    { oldValue: 'Good job! You learned an ability', newValue: 'Muito bem! Você aprendeu uma habilidade' },
    { oldValue: 'Click here to open your Spellbook to equip it', newValue: 'Abra o Livro de Feitiços e equipe-a' },
    { oldValue: 'The Spellbook', newValue: 'Livro de Feitiços' },
    { oldValue: 'Equip abilities from your Spellbook', newValue: 'Equipe habilidades do seu Livro de Feitiços' },
    { oldValue: 'Click this ability to add it to the hotbar', newValue: 'Clique nesta habilidade para colocá-la na barra' },
    { oldValue: 'Is this a Forge? Perhaps when I\'m more experienced...', newValue: 'Isso é uma forja? Talvez quando eu tiver mais experiência...' },
    { oldValue: 'This looks interesting. Perhaps when I\'m more experienced...', newValue: 'Isso parece interessante. Talvez quando eu tiver mais experiência...' },
    { oldValue: 'Wow! My very own barn. Perhaps when I\'m more experienced...', newValue: 'Uau! Minha própria incubadora. Talvez quando eu tiver mais experiência...' },
    { oldValue: 'Welcome, warrior. Enjoy the Guild Hall.', newValue: 'Seja bem-vindo,|bem-vinda, guerreiro.|guerreira. Aproveite o Sal\u00e3o da Guilda.' },
    { oldValue: 'My job is to look after these fine creatures.', newValue: 'Meu trabalho \u00e9 cuidar dessas belas criaturas.' },
    { oldValue: 'Please hatch more eggs, friend. Yval here might like a bit more company.', newValue: 'Por favor, choque mais ovos, amigo.|amiga. O Yval talvez queira mais companhia.' },
    { oldValue: 'Yep.', newValue: 'Sim.' },
    { oldValue: 'Maybe that old man knows how to open this...', newValue: 'Talvez o zelador saiba como abrir isso...' },
    { oldValue: 'Wait, I need to take the fork in the road', newValue: 'Espera, preciso seguir pela bifurcação.' },
    { oldValue: "It's right below me", newValue: 'Está aqui embaixo.' },
    { oldValue: 'UI_1.swf', newValue: `UI_1.swf?rv=${SWF_RUNTIME_VERSION}` },
    { oldValue: 'LevelsNR.swf', newValue: `LevelsNR.swf?rv=${SWF_RUNTIME_VERSION}` },
    { oldValue: 'LevelsTut.swf', newValue: `LevelsTut.swf?rv=${SWF_RUNTIME_VERSION}` },
];

const BRAZILIAN_PORTUGUESE_MAIN_SWF_SCRIPT_REPLACEMENTS: StringReplacement[] = [
    { oldValue: 'Wait, I need to take the fork in the road', newValue: 'Espera, preciso seguir pela bifurcação.' },
    { oldValue: "It's right below me", newValue: 'Está aqui embaixo.' }
];

const BRAZILIAN_PORTUGUESE_MAIN_SWF_UI_TEXT_REPLACEMENTS: StringReplacement[] = [
    { oldValue: 'Baglanti Koptu', newValue: 'Conexão Perdida' },
    { oldValue: 'Connection to the\nserver has been lost!', newValue: 'A conexão com o\nservidor foi perdida!' },
    { oldValue: "You aren't in a guild.", newValue: 'Você não está em uma guilda.' },
    { oldValue: 'No players in this area.', newValue: 'Não há jogadores nesta área.' }
];

const BRAZILIAN_PORTUGUESE_MAIN_SWF_TAG_REPLACEMENTS: StringReplacement[] = [
    { oldValue: 'UI_1.swf', newValue: `UI_1.swf?rv=${SWF_RUNTIME_VERSION}` },
    { oldValue: 'LevelsNR.swf', newValue: `LevelsNR.swf?rv=${SWF_RUNTIME_VERSION}` },
    { oldValue: 'LevelsTut.swf', newValue: `LevelsTut.swf?rv=${SWF_RUNTIME_VERSION}` },
];

const BRAZILIAN_PORTUGUESE_EMOTE_MENU_REPLACEMENTS = new Map<string, string>([
    ['Wave', 'Acenar'],
    ['Cheer', 'Celebrar'],
    ['Dance', 'Dancar'],
    ['Relaxed', 'Relaxar'],
    ['Charge', 'Avancar'],
    ['Point', 'Apontar'],
    ['Toss', 'Arremessar'],
    ['EyesOnYou', 'DeOlho'],
    ['Lean', 'Inclinar'],
    ['Yell', 'Gritar'],
    ['Flex', 'Exibir'],
    ['Sit', 'Sentar'],
    ['Shrug', 'Ombros'],
    ['Sharpen', 'Afiar'],
    ['Panic', 'Panico'],
    ['Read', 'Ler'],
    ['Float', 'Flutuar'],
    ['TaDah', 'Tada'],
    ['Kickball', 'Altinha'],
    ['End', 'Parar'],
    ['Leave', 'Sair'],
    ['AFK', 'Ausente']
]);

const BRAZILIAN_PORTUGUESE_EMOTE_COMMAND_ALIASES: Array<{ alias: string; canonical: string }> = [
    { alias: 'CONVIDAR', canonical: 'INVITE' },
    { alias: 'CONV', canonical: 'INVITE' },
    { alias: 'ENTRAR', canonical: 'JOIN' },
    { alias: 'ADICIONAR', canonical: 'FRIEND' },
    { alias: 'AMIGO', canonical: 'FRIEND' },
    { alias: 'SUSSURRAR', canonical: 'TELL' },
    { alias: 'SUSSURAR', canonical: 'TELL' },
    { alias: 'MSG', canonical: 'TELL' },
    { alias: 'SAIR', canonical: 'LEAVE' },
    { alias: 'IGNORAR', canonical: 'IGNORE' },
    { alias: 'IGN', canonical: 'IGNORE' },
    { alias: 'ACENAR', canonical: 'WAVE' },
    { alias: 'CELEBRAR', canonical: 'CHEER' },
    { alias: 'DANCAR', canonical: 'DANCE' },
    { alias: 'RELAXAR', canonical: 'RELAXED' },
    { alias: 'AVANCAR', canonical: 'CHARGE' },
    { alias: 'APONTAR', canonical: 'POINT' },
    { alias: 'ARREMESSAR', canonical: 'TOSS' },
    { alias: 'DEOLHO', canonical: 'EYESONYOU' },
    { alias: 'INCLINAR', canonical: 'LEAN' },
    { alias: 'GRITAR', canonical: 'YELL' },
    { alias: 'EXIBIR', canonical: 'FLEX' },
    { alias: 'SENTAR', canonical: 'SIT' },
    { alias: 'OMBROS', canonical: 'SHRUG' },
    { alias: 'AFIAR', canonical: 'SHARPEN' },
    { alias: 'PANICO', canonical: 'PANIC' },
    { alias: 'LER', canonical: 'READ' },
    { alias: 'FLUTUAR', canonical: 'FLOAT' },
    { alias: 'TADA', canonical: 'TADAH' },
    { alias: 'ALTINHA', canonical: 'KICKBALL' },
    { alias: 'EMBAIXADINHA', canonical: 'KICKBALL' },
    { alias: 'CHUTAR', canonical: 'KICKBALL' },
    { alias: 'PARAR', canonical: 'END' },
    { alias: 'AUSENTE', canonical: 'AFK' }
];

// The original SWF has "Lost Connection" and "Client Error" hardcoded in English,
// but the Turkish admin patched them to "Baglanti Koptu" / "Istemci Hatasi" directly
// in the string pool — so ALL locales currently show Turkish for these popups.
// These replacements restore English for EN/TR and localize for PT-BR.
const DISCONNECT_SCREEN_RESTORE_ENGLISH: StringReplacement[] = [
    { oldValue: 'Baglanti Koptu', newValue: 'Lost Connection' },
    { oldValue: 'Istemci Hatasi', newValue: 'Client Error' }
];

function getReplacements(mode: DungeonBlitzSwfMode, locale: DungeonBlitzSwfLocale): StringReplacement[] {
    const localeReplacements =
        locale === 'tr'
            ? TURKISH_DISCIPLINE_REPLACEMENTS
            : locale === 'pt-br'
                ? isBrazilianPortugueseMainSwfTextEnabled()
                    ? BRAZILIAN_PORTUGUESE_DISCIPLINE_REPLACEMENTS
                    : BRAZILIAN_PORTUGUESE_MAIN_SWF_SAFE_REPLACEMENTS
                : DISCONNECT_SCREEN_RESTORE_ENGLISH;
    const localRefreshUrl = locale === 'pt-br' ? LOCAL_PORTUGUESE_REFRESH_URL : LOCAL_REFRESH_URL;
    const remoteRefreshUrl = locale === 'pt-br' ? REMOTE_PORTUGUESE_REFRESH_URL : REMOTE_REFRESH_URL;
    if (mode === 'local') {
        return [
            { oldValue: REMOTE_HOST, newValue: LOCAL_HOST },
            { oldValue: REMOTE_ASSET_PATH, newValue: LOCAL_ASSET_PATH },
            { oldValue: OLD_REMOTE_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: OLD_REMOTE_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: OLD_LOCAL_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: OLD_LOCAL_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: PREVIOUS_REMOTE_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: PREVIOUS_REMOTE_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: PREVIOUS_LOCAL_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: PREVIOUS_LOCAL_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: CURRENT_PREVIOUS_REMOTE_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: CURRENT_PREVIOUS_REMOTE_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: CURRENT_PREVIOUS_LOCAL_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: CURRENT_PREVIOUS_LOCAL_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: CURRENT_REMOTE_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: CURRENT_REMOTE_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: CURRENT_LOCAL_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: CURRENT_LOCAL_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: REMOTE_REFRESH_URL, newValue: localRefreshUrl },
            { oldValue: REMOTE_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            { oldValue: LOCAL_REFRESH_URL_LEGACY, newValue: localRefreshUrl },
            ...LANGUAGE_COMMAND_PASSTHROUGH_REPLACEMENTS,
            ...localeReplacements
        ];
    }

    return [
        { oldValue: LOCAL_HOST, newValue: REMOTE_HOST },
        { oldValue: LOCAL_ASSET_PATH, newValue: REMOTE_ASSET_PATH },
        { oldValue: OLD_LOCAL_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: OLD_LOCAL_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: OLD_REMOTE_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: OLD_REMOTE_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: PREVIOUS_LOCAL_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: PREVIOUS_LOCAL_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: PREVIOUS_REMOTE_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: PREVIOUS_REMOTE_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: CURRENT_PREVIOUS_LOCAL_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: CURRENT_PREVIOUS_LOCAL_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: CURRENT_PREVIOUS_REMOTE_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: CURRENT_PREVIOUS_REMOTE_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: CURRENT_LOCAL_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: CURRENT_LOCAL_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: CURRENT_REMOTE_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: CURRENT_REMOTE_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: LOCAL_REFRESH_URL, newValue: remoteRefreshUrl },
        { oldValue: REMOTE_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        { oldValue: LOCAL_REFRESH_URL_LEGACY, newValue: remoteRefreshUrl },
        ...LANGUAGE_COMMAND_PASSTHROUGH_REPLACEMENTS,
        ...localeReplacements
    ];
}

function encodeSwfBuffer(ctx: ReturnType<typeof parseSwf>, body: Buffer): Buffer {
    const header = Buffer.alloc(8);
    header.write(ctx.signature, 0, 'ascii');
    header[3] = ctx.version;
    header.writeUInt32LE(8 + body.length, 4);

    return ctx.signature === 'CWS'
        ? Buffer.concat([header, zlib.deflateSync(body)])
        : Buffer.concat([header, body]);
}

function buildSwfStringReplacementBody(
    ctx: ReturnType<typeof parseSwf>,
    replacements: StringReplacement[]
): {
    body: Buffer;
    changed: boolean;
} {
    const abc = parseAbc(ctx);
    const patches = [];

    for (const replacement of longestFirstReplacements(replacements)) {
        for (let index = 1; index < abc.stringValues.length; index++) {
            if (abc.stringValues[index] !== replacement.oldValue) {
                continue;
            }

            const replacementBytes = Buffer.from(replacement.newValue, 'utf8');
            const originalBytes = Buffer.from(replacement.oldValue, 'utf8');
            patches.push({
                key: `string:${replacement.oldValue}:${index}`,
                start: abc.stringLenPositions[index],
                end: abc.stringDataPositions[index] + originalBytes.length,
                data: Buffer.concat([writeU30(replacementBytes.length), replacementBytes]),
                detail: `${replacement.oldValue} -> ${replacement.newValue}`
            });
        }
    }

    if (patches.length === 0) {
        return { body: Buffer.from(ctx.body), changed: false };
    }

    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    const outBody = Buffer.from(body);
    if (delta !== 0) {
        outBody.writeUInt32LE(ctx.doabcLen + delta, ctx.doabcLenFieldPos);
    }

    return { body: outBody, changed: true };
}

function collectDoAbcTags(ctx: ReturnType<typeof parseSwf>, body: Buffer = ctx.body): Array<{
    abcStart: number;
    doabcLenFieldPos: number;
    doabcLen: number;
    hasLongLength: boolean;
}> {
    const tags: Array<{
        abcStart: number;
        doabcLenFieldPos: number;
        doabcLen: number;
        hasLongLength: boolean;
    }> = [];
    let pos = 0;
    const nbits = body[0] >> 3;
    pos = Math.floor((5 + nbits * 4 + 7) / 8) + 4;

    while (pos < body.length) {
        const tagCodeAndLen = body.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        const hasLongLength = tagLen === 0x3f;
        const tagLenFieldPos = pos;
        if (hasLongLength) {
            tagLen = body.readUInt32LE(pos);
            pos += 4;
        }

        const tagDataStart = pos;
        const tagDataEnd = tagDataStart + tagLen;
        if (tagType === 82 || tagType === 72) {
            let abcStart = tagDataStart;
            if (tagType === 82) {
                let cursor = tagDataStart + 4;
                while (cursor < tagDataEnd && body[cursor] !== 0) {
                    cursor += 1;
                }
                abcStart = cursor + 1;
            }
            tags.push({
                abcStart,
                doabcLenFieldPos: tagLenFieldPos,
                doabcLen: tagLen,
                hasLongLength
            });
        }

        pos = tagDataEnd;
        if (tagType === 0) {
            break;
        }
    }

    return tags;
}

function buildAllSwfStringReplacementBody(
    ctx: ReturnType<typeof parseSwf>,
    replacements: StringReplacement[],
    initialBody: Buffer = ctx.body
): {
    body: Buffer;
    changed: boolean;
} {
    let body: Buffer = Buffer.from(initialBody);
    let changed = false;
    let deltaOffset = 0;

    for (const tag of collectDoAbcTags(ctx, initialBody)) {
        const tagCtx = {
            ...ctx,
            body,
            abcStart: tag.abcStart + deltaOffset,
            doabcLenFieldPos: tag.doabcLenFieldPos + deltaOffset,
            doabcLen: tag.doabcLen
        };
        const replaced = buildSwfStringReplacementBody(tagCtx, replacements);
        if (!replaced.changed) {
            continue;
        }
        if (!tag.hasLongLength && replaced.body.length !== body.length) {
            throw new Error(`Cannot resize short DoABC tag in ${ctx.path}`);
        }
        deltaOffset += replaced.body.length - body.length;
        body = replaced.body;
        changed = true;
    }

    return { body, changed };
}

export function buildSwfStringReplacementBuffer(
    swfPath: string,
    replacements: StringReplacement[]
): Buffer {
    const ctx = parseSwf(swfPath);
    const replaced = buildSwfStringReplacementBody(ctx, replacements);
    return replaced.changed ? encodeSwfBuffer(ctx, replaced.body) : Buffer.from(fs.readFileSync(swfPath));
}

function replaceSwfTagBytesInBody(
    body: Buffer,
    replacements: StringReplacement[],
    includeAbc = false
): {
    body: Buffer;
    changed: boolean;
    matchedStrings: string[];
} {
    let pos = 0;
    const nbits = body[0] >> 3;
    const firstTagPos = Math.floor((5 + nbits * 4 + 7) / 8) + 4;
    const chunks: Buffer[] = [body.subarray(0, firstTagPos)];
    pos = firstTagPos;
    let changed = false;
    const matchedStrings: string[] = [];

    while (pos < body.length) {
        const tagCodeAndLen = body.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            tagLen = body.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        let data: Buffer = Buffer.from(body.subarray(dataStart, dataEnd));
        const replaced = replaceSwfTagDataBytes(tagType, data, replacements, includeAbc);
        data = replaced.data;
        changed = replaced.changed || changed;
        for (const s of replaced.matched) {
            if (!matchedStrings.includes(s)) {
                matchedStrings.push(s);
            }
        }

        if (data.length < 0x3f) {
            const header = Buffer.alloc(2);
            header.writeUInt16LE((tagType << 6) | data.length, 0);
            chunks.push(header, data);
        } else {
            const header = Buffer.alloc(6);
            header.writeUInt16LE((tagType << 6) | 0x3f, 0);
            header.writeUInt32LE(data.length, 2);
            chunks.push(header, data);
        }

        pos = dataEnd;
        if (tagType === 0) {
            if (pos < body.length) {
                chunks.push(body.subarray(pos));
            }
            break;
        }
    }

    return { body: changed ? Buffer.concat(chunks) : Buffer.from(body), changed, matchedStrings };
}

export function buildSwfTagStringReplacementBuffer(
    swfPath: string,
    replacements: StringReplacement[]
): { buffer: Buffer; changed: boolean; matchedStrings: string[] } {
    const ctx = parseSwf(swfPath);
    const replaced = replaceSwfTagBytesInBody(ctx.body, replacements);
    const buffer = replaced.changed ? encodeSwfBuffer(ctx, replaced.body) : Buffer.from(fs.readFileSync(swfPath));
    return { buffer, changed: replaced.changed, matchedStrings: replaced.matchedStrings };
}

export function buildPortugueseLevelsNrSwfBuffer(swfPath: string): { buffer: Buffer; changed: boolean; matchedStrings: string[] } {
    const ctx = parseSwf(swfPath);
    const tagPatched = replaceSwfTagBytesInBody(ctx.body, BRAZILIAN_PORTUGUESE_ASSET_REPLACEMENTS);
    const scriptPatched = replaceSwfTagBytesInBody(
        tagPatched.body,
        BRAZILIAN_PORTUGUESE_LEVELS_NR_SCRIPT_REPLACEMENTS,
        true
    );
    const changed = tagPatched.changed || scriptPatched.changed;
    const matchedStrings = [...tagPatched.matchedStrings, ...scriptPatched.matchedStrings];
    const buffer = changed ? encodeSwfBuffer(ctx, scriptPatched.body) : Buffer.from(fs.readFileSync(swfPath));
    return { buffer, changed, matchedStrings };
}

export function buildPortugueseAssetSwfBuffer(
    swfPath: string,
    replacements: StringReplacement[] = BRAZILIAN_PORTUGUESE_ASSET_REPLACEMENTS
): Buffer {
    const ctx = parseSwf(swfPath);
    const abcPatched = buildSwfStringReplacementBody(ctx, replacements);
    const tagPatched = replaceSwfTagBytesInBody(abcPatched.body, replacements);
    const changed = abcPatched.changed || tagPatched.changed;
    return changed ? encodeSwfBuffer(ctx, tagPatched.body) : Buffer.from(fs.readFileSync(swfPath));
}

export function buildPortugueseExactAssetSwfBuffer(
    swfPath: string,
    replacements: StringReplacement[]
): Buffer {
    const ctx = parseSwf(swfPath);
    const patched = replaceSwfTagBytesInBody(ctx.body, replacements, true);
    return patched.changed ? encodeSwfBuffer(ctx, patched.body) : Buffer.from(fs.readFileSync(swfPath));
}

export function buildPortugueseUi4SwfBuffer(
    swfPath: string,
    replacements: StringReplacement[]
): Buffer {
    const ctx = parseSwf(swfPath);
    const sourceBody = ctx.body;
    let pos = 0;
    const nbits = sourceBody[0] >> 3;
    const firstTagPos = Math.floor((5 + nbits * 4 + 7) / 8) + 4;
    const chunks: Buffer[] = [sourceBody.subarray(0, firstTagPos)];
    pos = firstTagPos;
    let changed = false;

    while (pos < sourceBody.length) {
        const tagCodeAndLen = sourceBody.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            tagLen = sourceBody.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        let data: Buffer = Buffer.from(sourceBody.subarray(dataStart, dataEnd));
        if (tagType === 39) {
            const spriteId = data.readUInt16LE(0);
            const patched = patchUi4TooltipSprite(data, spriteId);
            data = patched.data;
            changed = patched.changed || changed;
        }
        if (tagType === 37 && data.length >= 2) {
            const patched = patchUi4EditText(data);
            data = patched.data;
            changed = patched.changed || changed;
        }

        const replaced = replaceSwfTagDataBytes(tagType, data, replacements, true);
        data = replaced.data;
        changed = replaced.changed || changed;
        chunks.push(encodeSwfTag(tagType, data));

        pos = dataEnd;
        if (tagType === 0) {
            if (pos < sourceBody.length) {
                chunks.push(sourceBody.subarray(pos));
            }
            break;
        }
    }

    return changed ? encodeSwfBuffer(ctx, Buffer.concat(chunks)) : Buffer.from(fs.readFileSync(swfPath));
}

type BitCursor = {
    byte: number;
    bit: number;
};

function readUnsignedBits(data: Buffer, cursor: BitCursor, bitCount: number): number {
    let value = 0;
    for (let index = 0; index < bitCount; index += 1) {
        value = (value << 1) | ((data[cursor.byte] >> (7 - cursor.bit)) & 1);
        cursor.bit += 1;
        if (cursor.bit === 8) {
            cursor.bit = 0;
            cursor.byte += 1;
        }
    }
    return value;
}

function readSignedBits(data: Buffer, cursor: BitCursor, bitCount: number): number {
    let value = readUnsignedBits(data, cursor, bitCount);
    const signBit = 1 << (bitCount - 1);
    if ((value & signBit) !== 0) {
        value -= 1 << bitCount;
    }
    return value;
}

function writeSignedBits(data: Buffer, cursor: BitCursor, bitCount: number, value: number): void {
    const min = -(1 << (bitCount - 1));
    const max = (1 << (bitCount - 1)) - 1;
    if (value < min || value > max) {
        throw new Error(`Cannot encode ${value} in ${bitCount} signed bits`);
    }

    let encoded = value < 0 ? (1 << bitCount) + value : value;
    for (let index = bitCount - 1; index >= 0; index -= 1) {
        const bit = (encoded >> index) & 1;
        const mask = 1 << (7 - cursor.bit);
        data[cursor.byte] = bit ? data[cursor.byte] | mask : data[cursor.byte] & ~mask;
        cursor.bit += 1;
        if (cursor.bit === 8) {
            cursor.bit = 0;
            cursor.byte += 1;
        }
    }
}

function writeUnsignedBits(data: Buffer, cursor: BitCursor, bitCount: number, value: number): void {
    if (value < 0 || value > 2 ** bitCount - 1) {
        throw new Error(`Cannot encode ${value} in ${bitCount} unsigned bits`);
    }

    for (let index = bitCount - 1; index >= 0; index -= 1) {
        const bit = (value >> index) & 1;
        const mask = 1 << (7 - cursor.bit);
        data[cursor.byte] = bit ? data[cursor.byte] | mask : data[cursor.byte] & ~mask;
        cursor.bit += 1;
        if (cursor.bit === 8) {
            cursor.bit = 0;
            cursor.byte += 1;
        }
    }
}

function alignBitCursor(cursor: BitCursor): void {
    if (cursor.bit !== 0) {
        cursor.bit = 0;
        cursor.byte += 1;
    }
}

function readSwfRect(data: Buffer, start: number): {
    end: number;
    nbits: number;
    xmin: number;
    xmax: number;
    ymin: number;
    ymax: number;
} {
    const cursor: BitCursor = { byte: start, bit: 0 };
    const nbits = readUnsignedBits(data, cursor, 5);
    const xmin = readSignedBits(data, cursor, nbits);
    const xmax = readSignedBits(data, cursor, nbits);
    const ymin = readSignedBits(data, cursor, nbits);
    const ymax = readSignedBits(data, cursor, nbits);
    alignBitCursor(cursor);
    return { end: cursor.byte, nbits, xmin, xmax, ymin, ymax };
}

function signedBitCountFor(values: number[]): number {
    for (let bitCount = 1; bitCount <= 31; bitCount += 1) {
        const min = -(2 ** (bitCount - 1));
        const max = 2 ** (bitCount - 1) - 1;
        if (values.every((value) => value >= min && value <= max)) {
            return bitCount;
        }
    }
    throw new Error(`Cannot encode RECT values: ${values.join(', ')}`);
}

function encodeSwfRect(xmin: number, xmax: number, ymin: number, ymax: number, minBits: number): Buffer {
    const nbits = Math.max(minBits, signedBitCountFor([xmin, xmax, ymin, ymax]));
    const data = Buffer.alloc(Math.ceil((5 + nbits * 4) / 8));
    const cursor: BitCursor = { byte: 0, bit: 0 };
    writeUnsignedBits(data, cursor, 5, nbits);
    writeSignedBits(data, cursor, nbits, xmin);
    writeSignedBits(data, cursor, nbits, xmax);
    writeSignedBits(data, cursor, nbits, ymin);
    writeSignedBits(data, cursor, nbits, ymax);
    return data;
}

function encodeSwfMatrix(scaleX: number | null, scaleY: number | null, tx: number, ty: number): Buffer {
    const scaleXFixed = scaleX === null ? null : Math.round(scaleX * 65536);
    const scaleYFixed = scaleY === null ? null : Math.round(scaleY * 65536);
    const hasScale = scaleXFixed !== null || scaleYFixed !== null;
    const scaleBits = hasScale
        ? signedBitCountFor([scaleXFixed ?? 65536, scaleYFixed ?? 65536])
        : 0;
    const translateBits = signedBitCountFor([tx, ty]);
    const bitLength = 1 + (hasScale ? 5 + scaleBits * 2 : 0) + 1 + 5 + translateBits * 2;
    const data = Buffer.alloc(Math.ceil(bitLength / 8));
    const cursor: BitCursor = { byte: 0, bit: 0 };

    writeUnsignedBits(data, cursor, 1, hasScale ? 1 : 0);
    if (hasScale) {
        writeUnsignedBits(data, cursor, 5, scaleBits);
        writeSignedBits(data, cursor, scaleBits, scaleXFixed ?? 65536);
        writeSignedBits(data, cursor, scaleBits, scaleYFixed ?? 65536);
    }
    writeUnsignedBits(data, cursor, 1, 0);
    writeUnsignedBits(data, cursor, 5, translateBits);
    writeSignedBits(data, cursor, translateBits, tx);
    writeSignedBits(data, cursor, translateBits, ty);

    return data;
}

function replaceBytes(data: Buffer, replacements: StringReplacement[]): {
    data: Buffer;
    changed: boolean;
    matched: string[];
} {
    let current = data;
    let changed = false;
    const matched: string[] = [];
    for (const replacement of longestFirstReplacements(replacements)) {
        const oldBytes = Buffer.from(replacement.oldValue, 'utf8');
        const newBytes = Buffer.from(replacement.newValue, 'utf8');
        let matchIndex = current.indexOf(oldBytes);
        if (matchIndex !== -1) {
            matched.push(replacement.oldValue);
        }
        while (matchIndex !== -1) {
            current = Buffer.concat([
                current.subarray(0, matchIndex),
                newBytes,
                current.subarray(matchIndex + oldBytes.length)
            ]);
            changed = true;
            matchIndex = current.indexOf(oldBytes, matchIndex + newBytes.length);
        }
    }

    return { data: current, changed, matched };
}

function replaceRawBytesExact(data: Buffer, replacements: StringReplacement[]): Buffer {
    let current = Buffer.from(data);
    for (const replacement of longestFirstReplacements(replacements)) {
        const oldBytes = Buffer.from(replacement.oldValue, 'utf8');
        const newBytes = Buffer.from(replacement.newValue, 'utf8');
        if (oldBytes.length !== newBytes.length) {
            throw new Error(`Raw SWF replacement must keep byte length: ${replacement.oldValue}`);
        }

        let matchIndex = current.indexOf(oldBytes);
        while (matchIndex !== -1) {
            newBytes.copy(current, matchIndex);
            matchIndex = current.indexOf(oldBytes, matchIndex + newBytes.length);
        }
    }

    return current;
}

function replaceDoAbcTagDataBytes(
    tagType: number,
    data: Buffer,
    replacements: StringReplacement[]
): {
    data: Buffer;
    changed: boolean;
    matched: string[];
} {
    let abcStart = 0;
    if (tagType === 82) {
        let cursor = 4;
        while (cursor < data.length && data[cursor] !== 0) {
            cursor += 1;
        }
        abcStart = cursor + 1;
    }

    const abc = parseAbc({
        path: 'embedded DoABC tag',
        signature: 'FWS',
        version: 0,
        body: data,
        doabcTagType: tagType,
        doabcLenFieldPos: -1,
        doabcLen: data.length,
        abcStart
    });
    const patches = [];
    const matched: string[] = [];

    for (const replacement of longestFirstReplacements(replacements)) {
        for (let index = 1; index < abc.stringValues.length; index++) {
            if (abc.stringValues[index] !== replacement.oldValue) {
                continue;
            }

            if (!matched.includes(replacement.oldValue)) {
                matched.push(replacement.oldValue);
            }
            const replacementBytes = Buffer.from(replacement.newValue, 'utf8');
            const originalBytes = Buffer.from(replacement.oldValue, 'utf8');
            patches.push({
                key: `embedded-string:${replacement.oldValue}:${index}`,
                start: abc.stringLenPositions[index],
                end: abc.stringDataPositions[index] + originalBytes.length,
                data: Buffer.concat([writeU30(replacementBytes.length), replacementBytes]),
                detail: `${replacement.oldValue} -> ${replacement.newValue}`
            });
        }
    }

    if (patches.length === 0) {
        return { data: Buffer.from(data), changed: false, matched: [] };
    }

    return {
        data: Buffer.from(applyPatchesToBody(data, patches).body),
        changed: true,
        matched
    };
}

function encodeSwfTag(tagType: number, data: Buffer): Buffer {
    if (data.length < 0x3f) {
        const header = Buffer.alloc(2);
        header.writeUInt16LE((tagType << 6) | data.length, 0);
        return Buffer.concat([header, data]);
    }

    const header = Buffer.alloc(6);
    header.writeUInt16LE((tagType << 6) | 0x3f, 0);
    header.writeUInt32LE(data.length, 2);
    return Buffer.concat([header, data]);
}

function replaceDefineSpriteTagBytes(data: Buffer, replacements: StringReplacement[], includeAbc = false): {
    data: Buffer;
    changed: boolean;
    matched: string[];
} {
    if (data.length < 4) {
        return { data: Buffer.from(data), changed: false, matched: [] };
    }

    let pos = 4;
    const chunks: Buffer[] = [data.subarray(0, 4)];
    let changed = false;
    const matched: string[] = [];

    while (pos < data.length) {
        const tagStart = pos;
        if (pos + 2 > data.length) {
            chunks.push(data.subarray(pos));
            break;
        }

        const tagCodeAndLen = data.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            if (pos + 4 > data.length) {
                chunks.push(data.subarray(pos - 2));
                break;
            }
            tagLen = data.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        if (dataEnd > data.length) {
            chunks.push(data.subarray(tagStart));
            break;
        }

        const replaced = replaceSwfTagDataBytes(
            tagType,
            Buffer.from(data.subarray(dataStart, dataEnd)),
            replacements,
            includeAbc
        );
        chunks.push(encodeSwfTag(tagType, replaced.data));
        changed = replaced.changed || changed;
        for (const s of replaced.matched) {
            if (!matched.includes(s)) {
                matched.push(s);
            }
        }

        pos = dataEnd;
        if (tagType === 0) {
            if (pos < data.length) {
                chunks.push(data.subarray(pos));
            }
            break;
        }
    }

    return { data: changed ? Buffer.concat(chunks) : Buffer.from(data), changed, matched };
}

function replaceSwfTagDataBytes(
    tagType: number,
    data: Buffer,
    replacements: StringReplacement[],
    includeAbc = false
): {
    data: Buffer;
    changed: boolean;
    matched: string[];
} {
    if (includeAbc && (tagType === 72 || tagType === 82)) {
        return replaceDoAbcTagDataBytes(tagType, data, replacements);
    }

    if (tagType === 72 || tagType === 76 || tagType === 82) {
        return { data: Buffer.from(data), changed: false, matched: [] };
    }

    if (tagType === 39) {
        return replaceDefineSpriteTagBytes(data, replacements, includeAbc);
    }

    if (tagType === 11 || tagType === 33 || tagType === 37) {
        return replaceBytes(data, replacements);
    }

    return { data: Buffer.from(data), changed: false, matched: [] };
}

function readSwfMatrix(data: Buffer, start: number): {
    end: number;
    tx: number;
    ty: number;
    txCursor: BitCursor;
    tyCursor: BitCursor;
    translateBits: number;
} {
    const cursor: BitCursor = { byte: start, bit: 0 };
    if (readUnsignedBits(data, cursor, 1) !== 0) {
        const scaleBits = readUnsignedBits(data, cursor, 5);
        readSignedBits(data, cursor, scaleBits);
        readSignedBits(data, cursor, scaleBits);
    }
    if (readUnsignedBits(data, cursor, 1) !== 0) {
        const rotateBits = readUnsignedBits(data, cursor, 5);
        readSignedBits(data, cursor, rotateBits);
        readSignedBits(data, cursor, rotateBits);
    }

    const translateBits = readUnsignedBits(data, cursor, 5);
    const txCursor = { ...cursor };
    const tx = readSignedBits(data, cursor, translateBits);
    const tyCursor = { ...cursor };
    const ty = readSignedBits(data, cursor, translateBits);
    alignBitCursor(cursor);
    return { end: cursor.byte, tx, ty, txCursor, tyCursor, translateBits };
}

const UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS = 440;
const UI1_TUTORIAL_PROMPT_QUESTION_ICON_X_SHIFT_TWIPS = 720;
const UI1_TUTORIAL_PROMPT_ICON_SHIFTS = new Map<number, Map<number, number>>([
    [586, new Map([[577, UI1_TUTORIAL_PROMPT_QUESTION_ICON_X_SHIFT_TWIPS], [579, UI1_TUTORIAL_PROMPT_QUESTION_ICON_X_SHIFT_TWIPS], [581, UI1_TUTORIAL_PROMPT_QUESTION_ICON_X_SHIFT_TWIPS]])],
    [587, new Map([[577, UI1_TUTORIAL_PROMPT_QUESTION_ICON_X_SHIFT_TWIPS], [579, UI1_TUTORIAL_PROMPT_QUESTION_ICON_X_SHIFT_TWIPS], [581, UI1_TUTORIAL_PROMPT_QUESTION_ICON_X_SHIFT_TWIPS]])],
    [598, new Map([[575, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [577, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [579, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [597, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS]])],
    [604, new Map([[577, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [579, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [603, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS]])],
    [610, new Map([[577, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [579, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [603, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS]])],
    [614, new Map([[575, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [577, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [579, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [597, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS]])],
    [620, new Map([[575, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [577, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [579, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS], [597, UI1_TUTORIAL_PROMPT_ICON_X_SHIFT_TWIPS]])]
]);

function patchUi1TutorialPromptSprite(data: Buffer, spriteId: number): boolean {
    const shifts = UI1_TUTORIAL_PROMPT_ICON_SHIFTS.get(spriteId);
    if (!shifts) {
        return false;
    }

    let changed = false;
    let pos = 4; // DefineSprite id + frame count.
    while (pos < data.length) {
        const tagCodeAndLen = data.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            tagLen = data.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        if (tagType === 26 || tagType === 70) {
            let cursor = dataStart;
            const flags = data[cursor];
            cursor += tagType === 70 ? 2 : 1;
            cursor += 2; // depth
            const hasCharacter = (flags & 0x02) !== 0;
            const hasMatrix = (flags & 0x04) !== 0;
            if (hasCharacter) {
                const characterId = data.readUInt16LE(cursor);
                cursor += 2;
                const shift = shifts.get(characterId);
                if (hasMatrix && shift !== undefined) {
                    const matrix = readSwfMatrix(data, cursor);
                    writeSignedBits(data, matrix.txCursor, matrix.translateBits, matrix.tx + shift);
                    changed = true;
                }
            }
        }

        pos = dataEnd;
        if (tagType === 0) {
            break;
        }
    }

    return changed;
}

function patchUi1SpritePlacements(data: Buffer, spriteId: number): {
    data: Buffer;
    changed: boolean;
} {
    const depthPatches = UI1_PORTUGUESE_SPRITE_PLACEMENT_PATCHES.get(spriteId);
    if (!depthPatches) {
        return { data, changed: false };
    }

    const chunks: Buffer[] = [data.subarray(0, 4)];
    let pos = 4;
    let changed = false;

    while (pos < data.length) {
        const tagCodeAndLen = data.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            tagLen = data.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        let tagData = Buffer.from(data.subarray(dataStart, dataEnd));
        if (tagType === 26 || tagType === 70) {
            let cursor = 0;
            const flags = tagData[cursor];
            cursor += tagType === 70 ? 2 : 1;
            const depth = tagData.readUInt16LE(cursor);
            cursor += 2;
            const patch = depthPatches.get(depth);
            const hasMatrix = (flags & 0x04) !== 0;
            if (patch && hasMatrix) {
                if ((flags & 0x02) !== 0) {
                    cursor += 2;
                }
                const matrix = readSwfMatrix(tagData, cursor);
                if (patch.scaleX === undefined) {
                    if (patch.tx !== undefined) {
                        writeSignedBits(tagData, matrix.txCursor, matrix.translateBits, patch.tx);
                    }
                    if (patch.ty !== undefined) {
                        writeSignedBits(tagData, matrix.tyCursor, matrix.translateBits, patch.ty);
                    }
                } else {
                    const encodedMatrix = encodeSwfMatrix(
                        patch.scaleX,
                        1,
                        patch.tx ?? matrix.tx,
                        patch.ty ?? matrix.ty
                    );
                    tagData = Buffer.concat([
                        tagData.subarray(0, cursor),
                        encodedMatrix,
                        tagData.subarray(matrix.end)
                    ]);
                }
                changed = true;
            }
        }

        chunks.push(encodeSwfTag(tagType, tagData));
        pos = dataEnd;
        if (tagType === 0) {
            if (pos < data.length) {
                chunks.push(data.subarray(pos));
            }
            break;
        }
    }

    return changed ? { data: Buffer.concat(chunks), changed } : { data, changed: false };
}

function patchUi1EditText(data: Buffer): {
    data: Buffer;
    changed: boolean;
} {
    const characterId = data.readUInt16LE(0);
    let current = data;
    let changed = false;

    const xMax = UI1_PORTUGUESE_EDIT_TEXT_XMAX.get(characterId);
    if (xMax !== undefined) {
        const bounds = readSwfRect(current, 2);
        if (bounds.xmax < xMax) {
            const encodedBounds = encodeSwfRect(bounds.xmin, xMax, bounds.ymin, bounds.ymax, bounds.nbits);
            current = Buffer.concat([
                current.subarray(0, 2),
                encodedBounds,
                current.subarray(bounds.end)
            ]);
            changed = true;
        }
    }

    const nextBounds = UI1_PORTUGUESE_EDIT_TEXT_BOUNDS.get(characterId);
    if (nextBounds !== undefined) {
        const bounds = readSwfRect(current, 2);
        if (bounds.xmin !== nextBounds.xmin || bounds.xmax !== nextBounds.xmax) {
            const encodedBounds = encodeSwfRect(nextBounds.xmin, nextBounds.xmax, bounds.ymin, bounds.ymax, bounds.nbits);
            current = Buffer.concat([
                current.subarray(0, 2),
                encodedBounds,
                current.subarray(bounds.end)
            ]);
            changed = true;
        }
    }

    const fontHeight = UI1_PORTUGUESE_EDIT_TEXT_FONT_HEIGHT.get(characterId);
    if (fontHeight !== undefined) {
        const bounds = readSwfRect(current, 2);
        let cursor = bounds.end;
        const flags = current[cursor];
        cursor += 2;
        const hasFont = (flags & 0x01) !== 0;
        if (hasFont) {
            cursor += 2;
            const currentHeight = current.readUInt16LE(cursor);
            if (currentHeight !== fontHeight) {
                const patched = Buffer.from(current);
                patched.writeUInt16LE(fontHeight, cursor);
                current = patched;
                changed = true;
            }
        }
    }

    const replacements = UI1_DEFINE_EDIT_TEXT_REPLACEMENTS.get(characterId);
    if (replacements) {
        const replaced = replaceBytes(current, replacements);
        current = replaced.data;
        changed = replaced.changed || changed;
    }

    return { data: current, changed };
}

function patchUi4EditText(data: Buffer): {
    data: Buffer;
    changed: boolean;
} {
    const characterId = data.readUInt16LE(0);
    let current = data;
    let changed = false;

    const xMax = UI4_PORTUGUESE_EDIT_TEXT_XMAX.get(characterId);
    if (xMax !== undefined) {
        const bounds = readSwfRect(current, 2);
        if (bounds.xmax < xMax) {
            const encodedBounds = encodeSwfRect(bounds.xmin, xMax, bounds.ymin, bounds.ymax, bounds.nbits);
            current = Buffer.concat([
                current.subarray(0, 2),
                encodedBounds,
                current.subarray(bounds.end)
            ]);
            changed = true;
        }
    }

    const nextBounds = UI4_PORTUGUESE_EDIT_TEXT_BOUNDS.get(characterId);
    if (nextBounds !== undefined) {
        const bounds = readSwfRect(current, 2);
        if (bounds.xmin !== nextBounds.xmin || bounds.xmax !== nextBounds.xmax) {
            const encodedBounds = encodeSwfRect(nextBounds.xmin, nextBounds.xmax, bounds.ymin, bounds.ymax, bounds.nbits);
            current = Buffer.concat([
                current.subarray(0, 2),
                encodedBounds,
                current.subarray(bounds.end)
            ]);
            changed = true;
        }
    }

    const replacements = UI4_DEFINE_EDIT_TEXT_REPLACEMENTS.get(characterId);
    if (replacements) {
        const replaced = replaceBytes(current, replacements);
        current = replaced.data;
        changed = replaced.changed || changed;
    }

    return { data: current, changed };
}

function patchUi4TooltipSprite(data: Buffer, spriteId: number): {
    data: Buffer;
    changed: boolean;
} {
    const scaleX = UI4_PORTUGUESE_TOOLTIP_SPRITE_SCALE_X.get(spriteId);
    const backgroundShift = UI4_PORTUGUESE_TOOLTIP_BACKGROUND_X_SHIFT_TWIPS.get(spriteId);
    const textShift = UI4_PORTUGUESE_TOOLTIP_TEXT_X_SHIFT_TWIPS.get(spriteId);
    if (scaleX === undefined && backgroundShift === undefined && textShift === undefined) {
        return { data, changed: false };
    }

    const chunks: Buffer[] = [data.subarray(0, 4)];
    let pos = 4;
    let changed = false;

    while (pos < data.length) {
        const tagCodeAndLen = data.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            tagLen = data.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        let tagData = Buffer.from(data.subarray(dataStart, dataEnd));
        if (tagType === 26 || tagType === 70) {
            let cursor = 0;
            const flags = tagData[cursor];
            cursor += tagType === 70 ? 2 : 1;
            const depth = tagData.readUInt16LE(cursor);
            cursor += 2;
            const hasMatrix = (flags & 0x04) !== 0;
            if ((depth === 2 || depth === 3) && hasMatrix) {
                if ((flags & 0x02) !== 0) {
                    cursor += 2;
                }
                const matrix = readSwfMatrix(tagData, cursor);
                const nextScaleX = depth === 2 && scaleX !== undefined ? scaleX : null;
                const nextTx =
                    depth === 2 && backgroundShift !== undefined
                        ? matrix.tx + backgroundShift
                        : depth === 3 && textShift !== undefined
                            ? matrix.tx + textShift
                            : matrix.tx;
                const encodedMatrix = encodeSwfMatrix(nextScaleX, 1, nextTx, matrix.ty);
                tagData = Buffer.concat([
                    tagData.subarray(0, cursor),
                    encodedMatrix,
                    tagData.subarray(matrix.end)
                ]);
                changed = true;
            }
        }

        chunks.push(encodeSwfTag(tagType, tagData));
        pos = dataEnd;
        if (tagType === 0) {
            if (pos < data.length) {
                chunks.push(data.subarray(pos));
            }
            break;
        }
    }

    return changed ? { data: Buffer.concat(chunks), changed } : { data, changed };
}

function getUi1AbcReplacements(replacements: StringReplacement[]): StringReplacement[] {
    return replacements.filter((replacement) => !UI1_TAG_ONLY_OLDVALUES.has(replacement.oldValue));
}

export function buildPortugueseUi1SwfBuffer(
    swfPath: string,
    replacements: StringReplacement[]
): Buffer {
    const ctx = parseSwf(swfPath);
    const abcPatched = buildSwfStringReplacementBody(ctx, getUi1AbcReplacements(replacements));
    const sourceBody = abcPatched.body;
    let pos = 0;
    const nbits = sourceBody[0] >> 3;
    const firstTagPos = Math.floor((5 + nbits * 4 + 7) / 8) + 4;
    const chunks: Buffer[] = [sourceBody.subarray(0, firstTagPos)];
    pos = firstTagPos;
    let changed = abcPatched.changed;

    while (pos < sourceBody.length) {
        const tagCodeAndLen = sourceBody.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            tagLen = sourceBody.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        let data: Buffer = Buffer.from(sourceBody.subarray(dataStart, dataEnd));
        if (tagType === 39) {
            const spriteId = data.readUInt16LE(0);
            changed = patchUi1TutorialPromptSprite(data, spriteId) || changed;
            const patched = patchUi1SpritePlacements(data, spriteId);
            data = patched.data;
            changed = patched.changed || changed;
        }
        if (tagType === 37) {
            const patched = patchUi1EditText(data);
            data = patched.data;
            changed = patched.changed || changed;
        }
        const replaced = replaceSwfTagDataBytes(tagType, data, replacements);
        data = replaced.data;
        changed = replaced.changed || changed;

        if (data.length < 0x3f) {
            const header = Buffer.alloc(2);
            header.writeUInt16LE((tagType << 6) | data.length, 0);
            chunks.push(header, data);
        } else {
            const header = Buffer.alloc(6);
            header.writeUInt16LE((tagType << 6) | 0x3f, 0);
            header.writeUInt32LE(data.length, 2);
            chunks.push(header, data);
        }

        pos = dataEnd;
        if (tagType === 0) {
            if (pos < sourceBody.length) {
                chunks.push(sourceBody.subarray(pos));
            }
            break;
        }
    }

    if (!changed) {
        return Buffer.from(fs.readFileSync(swfPath));
    }

    return encodeSwfBuffer(ctx, Buffer.concat(chunks));
}

function buildMountedSpeedPatch(ctx: ReturnType<typeof parseSwf>) {
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, MOUNT_SPEED_PATCH_CLASS);
    if (classIndex === null) {
        throw new Error(`${MOUNT_SPEED_PATCH_CLASS} class not found in ${ctx.path}`);
    }

    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, MOUNT_SPEED_PATCH_METHOD);
    if (methodIdx === null) {
        throw new Error(`${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD} not found in ${ctx.path}`);
    }

    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
        throw new Error(`${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD} body not found in ${ctx.path}`);
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, `${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD}`);
    const mountedGuardIndex = instructions.findIndex(
        (instruction) => u30OperandName(instruction, abc.multinameNames) === 'var_270'
    );
    if (mountedGuardIndex === -1) {
        throw new Error(`Mounted guard not found in ${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD}`);
    }

    const dungeonFlagInstruction = instructions.find(
        (instruction, index) =>
            index > mountedGuardIndex &&
            instruction.opcode === 0x66 &&
            u30OperandName(instruction, abc.multinameNames) === MOUNT_SPEED_DUNGEON_FLAG
    );
    if (!dungeonFlagInstruction) {
        throw new Error(`${MOUNT_SPEED_DUNGEON_FLAG} access not found in ${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD}`);
    }

    const patchedSequence = Buffer.from([0x29, 0x27, 0x02]);
    const currentSequence = code.subarray(
        dungeonFlagInstruction.offset,
        dungeonFlagInstruction.offset + patchedSequence.length
    );
    if (currentSequence.equals(patchedSequence)) {
        return [];
    }

    return [
        {
            key: `${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD}.dungeonFlag`,
            start: methodBody.codeStart + dungeonFlagInstruction.offset,
            end: methodBody.codeStart + dungeonFlagInstruction.offset + patchedSequence.length,
            data: patchedSequence,
            detail: 'replace dungeon mount-speed flag read with false'
        }
    ];
}

function buildCharacterCreationGenderPatch(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>) {
    const classIdx = classIndexByName(abc, 'ScreenCharacterCreation');
    if (classIdx === null) {
        throw new Error('ScreenCharacterCreation class not found in DungeonBlitz.swf');
    }

    const methodIdx = methodIdxForTrait(abc.instances[classIdx].traits, abc, 'method_604');
    if (methodIdx === null) {
        throw new Error('ScreenCharacterCreation.method_604 not found in DungeonBlitz.swf');
    }

    const body = abc.methodBodies.get(methodIdx);
    if (!body) {
        throw new Error('ScreenCharacterCreation.method_604 body not found in DungeonBlitz.swf');
    }

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);

    const originalSequence = Buffer.from([
        0x60, 0xE8, 0x07,              // getlex class_102
        0xD0,                           // getlocal0
        0x66, 0xB8, 0x07,              // getproperty var_250
        0xD0,                           // getlocal0
        0x66, 0xF7, 0x06,              // getproperty var_216
        0x46, 0xDB, 0x15, 0x02         // callproperty method_198 2
    ]);

    const patchOffset = 20;
    const actual = code.subarray(patchOffset, patchOffset + originalSequence.length);
    if (!Buffer.from(actual).equals(originalSequence)) {
        throw new Error('ScreenCharacterCreation.method_604 gender sequence mismatch — SWF may have changed');
    }

    const patchedSequence = Buffer.from([
        0xD0,                           // getlocal0
        0x66, 0xF7, 0x06,              // getproperty var_216
        0x02, 0x02, 0x02, 0x02, 0x02,  // nop padding
        0x02, 0x02, 0x02, 0x02, 0x02, 0x02
    ]);

    return [{
        key: 'character-creation-gender',
        start: body.codeStart + patchOffset,
        end: body.codeStart + patchOffset + originalSequence.length,
        data: patchedSequence,
        detail: 'send var_216 ("Male"/"Female") directly instead of class_102.method_198 which returns empty string'
    }];
}

function findMultinameIndex(abc: ReturnType<typeof parseAbc>, name: string, preferredIndex?: number): number {
    if (preferredIndex !== undefined && abc.multinameNames[preferredIndex] === name) {
        return preferredIndex;
    }
    const index = abc.multinameNames.findIndex((entry) => entry === name);
    if (index === -1) {
        throw new Error(`Multiname ${name} not found in DungeonBlitz.swf`);
    }
    return index;
}

function buildDisconnectRefreshButtonPlacementPatch(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>) {
    const classIndex = classIndexByName(abc, 'class_67');
    if (classIndex === null) {
        throw new Error('class_67 disconnect screen class not found in DungeonBlitz.swf');
    }

    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, 'OnCreateScreen');
    if (methodIdx === null) {
        throw new Error('class_67.OnCreateScreen not found in DungeonBlitz.swf');
    }

    const body = abc.methodBodies.get(methodIdx);
    if (!body) {
        throw new Error('class_67.OnCreateScreen body not found in DungeonBlitz.swf');
    }

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, 'class_67.OnCreateScreen');
    if (instructions.some((instruction, index) =>
        instruction.opcode === 0x66 &&
        u30OperandName(instruction, abc.multinameNames) === 'am_Refresh' &&
        instructions[index + 1]?.opcode === 0x2a &&
        instructions[index + 2]?.opcode === 0x66 &&
        u30OperandName(instructions[index + 2], abc.multinameNames) === 'x'
    )) {
        return [];
    }

    const pushScope = instructions.find((instruction) => instruction.opcode === 0x30);
    if (!pushScope) {
        throw new Error('class_67.OnCreateScreen pushscope not found in DungeonBlitz.swf');
    }

    const var2Index = findMultinameIndex(abc, 'var_2', 19);
    const refreshIndex = findMultinameIndex(abc, 'am_Refresh', 11750);
    const xIndex = findMultinameIndex(abc, 'x', 11738);
    const yIndex = findMultinameIndex(abc, 'y', 11739);
    const injection = Buffer.concat([
        Buffer.from([0x60]), writeU30(var2Index),      // getlex var_2
        Buffer.from([0x66]), writeU30(refreshIndex),   // getproperty am_Refresh
        Buffer.from([0x2a]),                           // dup
        Buffer.from([0x66]), writeU30(xIndex),         // getproperty x
        pushByteInstruction(DISCONNECT_REFRESH_BUTTON_X_OFFSET_PX),
        Buffer.from([0xa0]),                           // add
        Buffer.from([0x61]), writeU30(xIndex),         // setproperty x
        Buffer.from([0x60]), writeU30(var2Index),      // getlex var_2
        Buffer.from([0x66]), writeU30(refreshIndex),   // getproperty am_Refresh
        Buffer.from([0x2a]),                           // dup
        Buffer.from([0x66]), writeU30(yIndex),         // getproperty y
        pushByteInstruction(DISCONNECT_REFRESH_BUTTON_Y_OFFSET_PX),
        Buffer.from([0xa0]),                           // add
        Buffer.from([0x61]), writeU30(yIndex),         // setproperty y
    ]);
    const insertionOffset = pushScope.offset + pushScope.size;

    return [
        {
            key: 'disconnect-refresh-button-x-code-length',
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen + injection.length),
            detail: 'increase class_67.OnCreateScreen code length for refresh button x-offset'
        },
        {
            key: 'disconnect-refresh-button-x-offset',
            start: body.codeStart + insertionOffset,
            end: body.codeStart + insertionOffset,
            data: injection,
            detail: 'nudge disconnect refresh button into the center of its frame'
        }
    ];
}

function writeS24(value: number): Buffer {
    if (value < -0x800000 || value > 0x7fffff) {
        throw new Error(`s24 cannot encode value ${value}`);
    }
    const out = Buffer.alloc(3);
    out.writeIntLE(value, 0, 3);
    return out;
}

function pushStringInstruction(stringIndex: number): Buffer {
    return Buffer.concat([Buffer.from([0x2c]), writeU30(stringIndex)]);
}

function pushByteInstruction(value: number): Buffer {
    if (value < -128 || value > 127) {
        throw new Error(`pushbyte cannot encode value ${value}`);
    }
    return Buffer.from([0x24, value & 0xff]);
}

function buildBranchAdjustmentPatches(
    methodBody: NonNullable<ReturnType<typeof parseAbc>['methodBodies'] extends Map<number, infer T> ? T : never>,
    code: Buffer,
    insertionOffset: number,
    insertionLength: number,
    keyPrefix: string
) {
    const patches = [];
    for (const instruction of disassemble(code, keyPrefix)) {
        const operand = instruction.operands[0];
        if (!operand || operand[0] !== 's24') {
            continue;
        }

        const instructionEnd = instruction.offset + instruction.size;
        const target = instructionEnd + operand[1];
        let nextOperand = operand[1];
        if (instruction.offset < insertionOffset && target >= insertionOffset) {
            nextOperand += insertionLength;
        } else if (instruction.offset >= insertionOffset && target < insertionOffset) {
            nextOperand -= insertionLength;
        } else {
            continue;
        }

        patches.push({
            key: `${keyPrefix}:branch:${instruction.offset}`,
            start: methodBody.codeStart + instruction.offset + 1,
            end: methodBody.codeStart + instruction.offset + instruction.size,
            data: writeS24(nextOperand),
            detail: `adjust ${keyPrefix} branch at ${instruction.offset} across injected PT-BR emote code`
        });
    }
    return patches;
}

function buildBrazilianPortugueseEmotePatches(
    ctx: ReturnType<typeof parseSwf>,
    abc: ReturnType<typeof parseAbc>,
    internString: StringInterner
) {
    for (const value of BRAZILIAN_PORTUGUESE_EMOTE_MENU_REPLACEMENTS.keys()) {
        internString(value);
    }
    for (const value of BRAZILIAN_PORTUGUESE_EMOTE_MENU_REPLACEMENTS.values()) {
        internString(value);
    }
    for (const { alias, canonical } of BRAZILIAN_PORTUGUESE_EMOTE_COMMAND_ALIASES) {
        internString(alias);
        internString(canonical);
    }

    const patches = [];
    const chatClassIndex = classIndexByName(abc, 'class_127');
    if (chatClassIndex === null) {
        throw new Error('class_127 not found in DungeonBlitz.swf');
    }

    const menuMethodIdx = methodIdxForTrait(abc.instances[chatClassIndex].traits, abc, 'method_1237');
    if (menuMethodIdx === null) {
        throw new Error('class_127.method_1237 not found in DungeonBlitz.swf');
    }

    const menuBody = abc.methodBodies.get(menuMethodIdx);
    if (!menuBody) {
        throw new Error('class_127.method_1237 body not found in DungeonBlitz.swf');
    }

    const menuCode = ctx.body.subarray(menuBody.codeStart, menuBody.codeStart + menuBody.codeLen);
    const menuInsertionOffset = 407;
    const expectedMenuInsertionBytes = Buffer.from([0x5d, 0x11]);
    if (!menuCode.subarray(menuInsertionOffset, menuInsertionOffset + expectedMenuInsertionBytes.length).equals(expectedMenuInsertionBytes)) {
        throw new Error('class_127.method_1237 has an unexpected emote menu construction block');
    }

    const labelCodeChunks = [];
    for (const [source, label] of BRAZILIAN_PORTUGUESE_EMOTE_MENU_REPLACEMENTS) {
        const assignLabel = Buffer.concat([
            pushStringInstruction(internString(label)),
            Buffer.from([0x85, 0x63, 0x05])
        ]);
        labelCodeChunks.push(Buffer.concat([
            Buffer.from([0x62, 0x05]),
            pushStringInstruction(internString(source)),
            Buffer.from([0x14]),
            writeS24(assignLabel.length),
            assignLabel
        ]));
    }
    const labelCode = Buffer.concat(labelCodeChunks);

    patches.push({
        key: 'ptbr-emote-menu-labels',
        start: menuBody.codeStart + menuInsertionOffset,
        end: menuBody.codeStart + menuInsertionOffset,
        data: labelCode,
        detail: 'localize displayed PT-BR emote labels without changing the canonical class_127.const_245 lists'
    });
    patches.push({
        key: 'ptbr-emote-menu-labels-code-length',
        start: menuBody.codeLenPos,
        end: menuBody.codeStart,
        data: writeU30(menuBody.codeLen + labelCode.length),
        detail: 'increase class_127.method_1237 code length for PT-BR emote labels'
    });
    patches.push(...buildBranchAdjustmentPatches(
        menuBody,
        menuCode,
        menuInsertionOffset,
        labelCode.length,
        'class_127.method_1237.ptbr-emote-menu-labels'
    ));

    const commandMethodIdx = methodIdxForTrait(abc.instances[chatClassIndex].traits, abc, 'method_1260');
    if (commandMethodIdx === null) {
        throw new Error('class_127.method_1260 not found in DungeonBlitz.swf');
    }

    const commandBody = abc.methodBodies.get(commandMethodIdx);
    if (!commandBody) {
        throw new Error('class_127.method_1260 body not found in DungeonBlitz.swf');
    }

    const commandCode = ctx.body.subarray(commandBody.codeStart, commandBody.codeStart + commandBody.codeLen);
    const insertionOffset = 222;
    const expectedInsertionBytes = Buffer.from([0x60, 0x01]);
    if (!commandCode.subarray(insertionOffset, insertionOffset + expectedInsertionBytes.length).equals(expectedInsertionBytes)) {
        throw new Error('class_127.method_1260 has an unexpected command parsing prologue');
    }

    const aliasCodeChunks = [];
    for (const { alias, canonical } of BRAZILIAN_PORTUGUESE_EMOTE_COMMAND_ALIASES) {
        const assignCanonical = Buffer.concat([
            pushStringInstruction(internString(canonical)),
            Buffer.from([0x85, 0xd5])
        ]);
        aliasCodeChunks.push(Buffer.concat([
            Buffer.from([0xd1]),
            pushStringInstruction(internString(alias)),
            Buffer.from([0x14]),
            writeS24(assignCanonical.length),
            assignCanonical
        ]));
    }
    const aliasCode = Buffer.concat(aliasCodeChunks);

    patches.push({
        key: 'ptbr-emote-command-aliases',
        start: commandBody.codeStart + insertionOffset,
        end: commandBody.codeStart + insertionOffset,
        data: aliasCode,
        detail: 'normalize PT-BR emote chat commands to canonical English emote commands'
    });
    patches.push({
        key: 'ptbr-emote-command-aliases-code-length',
        start: commandBody.codeLenPos,
        end: commandBody.codeStart,
        data: writeU30(commandBody.codeLen + aliasCode.length),
        detail: 'increase class_127.method_1260 code length for PT-BR emote aliases'
    });
    patches.push(...buildBranchAdjustmentPatches(
        commandBody,
        commandCode,
        insertionOffset,
        aliasCode.length,
        'class_127.method_1260.ptbr-emote-command-aliases'
    ));

    return patches;
}

const BRAZILIAN_PORTUGUESE_CHAT_CHANNEL_LABELS = new Map<string, string>([
    ['Officer', 'Oficiais'],
    ['Guild', 'Guilda'],
    ['Party', 'Grupo'],
    ['Say', 'Local']
]);

const BRAZILIAN_PORTUGUESE_CHAT_CHANNEL_PUSHSTRING_PATCHES = [
    {
        methodIdx: 3756,
        offsets: [182, 185, 188, 191, 1567, 1579, 1591, 1603, 1752, 1764, 1776, 1800],
        detail: 'localize chat channel menu labels, label-to-command mappings, and color-map keys'
    },
    {
        methodIdx: 3716,
        offsets: [1140, 1247, 1354, 1452],
        detail: 'localize chat channel status labels after slash-command parsing'
    },
    {
        methodIdx: 3731,
        offsets: [142, 156, 170, 184],
        detail: 'localize chat channel dropdown click comparisons'
    },
    {
        methodIdx: 3557,
        offsets: [414, 428, 456, 470],
        detail: 'localize automatic chat channel fallback comparisons'
    }
];

function buildBrazilianPortugueseChatChannelLabelPatches(
    ctx: ReturnType<typeof parseSwf>,
    abc: ReturnType<typeof parseAbc>,
    internString: StringInterner
) {
    for (const value of BRAZILIAN_PORTUGUESE_CHAT_CHANNEL_LABELS.values()) {
        internString(value);
    }

    const patches = [];
    for (const methodPatch of BRAZILIAN_PORTUGUESE_CHAT_CHANNEL_PUSHSTRING_PATCHES) {
        const methodBody = abc.methodBodies.get(methodPatch.methodIdx);
        if (!methodBody) {
            throw new Error(`DungeonBlitz.swf method ${methodPatch.methodIdx} body not found for PT-BR chat channel labels`);
        }

        const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
        const instructions = new Map(disassemble(code, `m${methodPatch.methodIdx}`).map((instruction) => [instruction.offset, instruction]));
        for (const offset of methodPatch.offsets) {
            const instruction = instructions.get(offset);
            if (!instruction || instruction.opcode !== 0x2c) {
                throw new Error(`DungeonBlitz.swf method ${methodPatch.methodIdx} offset ${offset} is not the expected pushstring`);
            }

            const oldIndex = instruction.operands[0]?.[1];
            const oldValue = abc.stringValues[oldIndex];
            const newValue = BRAZILIAN_PORTUGUESE_CHAT_CHANNEL_LABELS.get(oldValue);
            if (!newValue) {
                throw new Error(`DungeonBlitz.swf method ${methodPatch.methodIdx} offset ${offset} pushes unexpected string "${oldValue}"`);
            }

            const replacementOperand = writeU30(internString(newValue));
            const operandStart = methodBody.codeStart + instruction.offset + 1;
            const operandEnd = methodBody.codeStart + instruction.offset + instruction.size;
            if (replacementOperand.length !== operandEnd - operandStart) {
                throw new Error(`PT-BR chat channel label "${newValue}" changed pushstring operand width at m${methodPatch.methodIdx}:${offset}`);
            }

            patches.push({
                key: `ptbr-chat-channel-label:${methodPatch.methodIdx}:${offset}`,
                start: operandStart,
                end: operandEnd,
                data: replacementOperand,
                detail: `${methodPatch.detail}: ${oldValue} -> ${newValue}`
            });
        }
    }

    return patches;
}

function buildBrazilianPortugueseChatChannelMenuLayoutPatches(
    ctx: ReturnType<typeof parseSwf>,
    abc: ReturnType<typeof parseAbc>
) {
    const methodIdx = 3722;
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
        throw new Error('DungeonBlitz.swf class_127 channel menu body not found for PT-BR layout patch');
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const insertionOffset = 324;
    const expectedBytes = Buffer.from([0x60, 0x12, 0x62, 0x08]);
    if (!code.subarray(insertionOffset, insertionOffset + expectedBytes.length).equals(expectedBytes)) {
        throw new Error('DungeonBlitz.swf class_127 channel menu layout block is not at the expected offset');
    }

    const widthIndex = requireMultinameIndex(abc, 'width');
    const injectedCode = Buffer.concat([
        Buffer.from([0x62]), writeU30(8), // current option's am_Text field.
        Buffer.from([0x24, 58]), // pixels; enough for "Oficiais" without moving the shortcut column.
        Buffer.from([0x61]), writeU30(widthIndex)
    ]);

    return [
        {
            key: 'ptbr-chat-channel-menu-label-width',
            start: methodBody.codeStart + insertionOffset,
            end: methodBody.codeStart + insertionOffset,
            data: injectedCode,
            detail: 'widen PT-BR chat channel label field so "Oficiais" is not clipped'
        },
        {
            key: 'ptbr-chat-channel-menu-label-width-code-length',
            start: methodBody.codeLenPos,
            end: methodBody.codeStart,
            data: writeU30(methodBody.codeLen + injectedCode.length),
            detail: 'increase class_127 chat channel menu code length for PT-BR label width patch'
        },
        ...buildBranchAdjustmentPatches(
            methodBody,
            code,
            insertionOffset,
            injectedCode.length,
            'class_127.ptbr-chat-channel-menu-label-width'
        )
    ];
}

function buildBrazilianPortugueseChatCommandMenuLabelPatches(
    ctx: ReturnType<typeof parseSwf>,
    abc: ReturnType<typeof parseAbc>,
    internString: StringInterner
) {
    const methodIdx = 3652;
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
        throw new Error('DungeonBlitz.swf class_127.method_1237 body not found for PT-BR chat command labels');
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = new Map(disassemble(code, `m${methodIdx}`).map((instruction) => [instruction.offset, instruction]));
    const offset = 256;
    const instruction = instructions.get(offset);
    if (!instruction || instruction.opcode !== 0x2c) {
        throw new Error('DungeonBlitz.swf class_127.method_1237 leave label is not the expected pushstring');
    }

    const oldIndex = instruction.operands[0]?.[1];
    if (abc.stringValues[oldIndex] !== 'Leave') {
        throw new Error(`DungeonBlitz.swf class_127.method_1237 leave label pushes unexpected string "${abc.stringValues[oldIndex]}"`);
    }

    const replacementOperand = writeU30(internString('Sair'));
    const operandStart = methodBody.codeStart + instruction.offset + 1;
    const operandEnd = methodBody.codeStart + instruction.offset + instruction.size;
    if (replacementOperand.length !== operandEnd - operandStart) {
        throw new Error('PT-BR chat command label "Sair" changed pushstring operand width');
    }

    return [{
        key: 'ptbr-chat-command-label-leave',
        start: operandStart,
        end: operandEnd,
        data: replacementOperand,
        detail: 'localize displayed PT-BR chat command label Leave -> Sair without changing command keys'
    }];
}

function requireMultinameIndex(abc: ReturnType<typeof parseAbc>, name: string): number {
    const index = abc.multinameNames.findIndex((value) => value === name);
    if (index < 0) {
        throw new Error(`DungeonBlitz.swf missing multiname ${name}`);
    }
    return index;
}

function buildCallPropertyInstruction(opcode: number, multinameIndex: number, argumentCount: number): Buffer {
    return Buffer.concat([Buffer.from([opcode]), writeU30(multinameIndex), writeU30(argumentCount)]);
}

function buildLocalizationReloadStatusPatch(
    ctx: ReturnType<typeof parseSwf>,
    abc: ReturnType<typeof parseAbc>,
    internString: StringInterner
) {
    const patches = [];
    const linkUpdaterClassIndex = classIndexByName(abc, 'LinkUpdater');
    if (linkUpdaterClassIndex === null) {
        throw new Error('LinkUpdater class not found in DungeonBlitz.swf');
    }

    const methodIdx = methodIdxForTrait(abc.instances[linkUpdaterClassIndex].traits, abc, 'method_1844');
    if (methodIdx === null) {
        throw new Error('LinkUpdater.method_1844 not found in DungeonBlitz.swf');
    }

    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
        throw new Error('LinkUpdater.method_1844 body not found in DungeonBlitz.swf');
    }

    const currentCode = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const expectedPrefix = Buffer.from([
        0xd0, 0x30, 0xef, 0x01, 0x98, 0x75, 0x00, 0x00, 0xef, 0x01, 0xc8, 0x76, 0x01, 0xa3, 0x15,
        0xd1
    ]);
    if (!currentCode.subarray(0, expectedPrefix.length).equals(expectedPrefix)) {
        throw new Error('LinkUpdater.method_1844 has an unexpected status-message prologue');
    }

    const reloadPrefixIndex = internString('DB_LOCALIZATION_RELOAD:');
    const topIndex = internString('_top');
    const method13Index = requireMultinameIndex(abc, 'method_13');
    const indexOfIndex = requireMultinameIndex(abc, 'indexOf');
    const externalInterfaceIndex = requireMultinameIndex(abc, 'ExternalInterface');
    const availableIndex = requireMultinameIndex(abc, 'available');
    const navigateToUrlIndex = requireMultinameIndex(abc, 'navigateToURL');
    const urlRequestIndex = requireMultinameIndex(abc, 'URLRequest');
    const substrIndex = requireMultinameIndex(abc, 'substr');
    const var1Index = requireMultinameIndex(abc, 'var_1');
    const screenChatIndex = requireMultinameIndex(abc, 'screenChat');
    const readUnsafeStatusTextIndex = requireMultinameIndex(abc, 'ReadUnsafeStatusText');

    const navigateBlock = Buffer.concat([
        Buffer.from([0x5d]), writeU30(navigateToUrlIndex),
        Buffer.from([0x5d]), writeU30(urlRequestIndex),
        Buffer.from([0xd2, 0x24, 23]),
        buildCallPropertyInstruction(0x46, substrIndex, 1),
        buildCallPropertyInstruction(0x4a, urlRequestIndex, 1),
        pushStringInstruction(topIndex),
        buildCallPropertyInstruction(0x4f, navigateToUrlIndex, 2),
        Buffer.from([0x47])
    ]);
    const reloadBlock = Buffer.concat([
        Buffer.from([0x60]), writeU30(externalInterfaceIndex),
        Buffer.from([0x66]), writeU30(availableIndex),
        Buffer.from([0x12]),
        writeS24(navigateBlock.length),
        navigateBlock,
        Buffer.from([0x47])
    ]);
    const normalStatusBlock = Buffer.concat([
        Buffer.from([0xd0, 0x66]), writeU30(var1Index),
        Buffer.from([0x66]), writeU30(screenChatIndex),
        Buffer.from([0xd2]),
        buildCallPropertyInstruction(0x4f, readUnsafeStatusTextIndex, 1),
        Buffer.from([0x47])
    ]);
    const newCode = Buffer.concat([
        currentCode.subarray(0, 15),
        Buffer.from([0xd1]),
        buildCallPropertyInstruction(0x46, method13Index, 0),
        Buffer.from([0x85, 0xd6, 0xd2]),
        pushStringInstruction(reloadPrefixIndex),
        buildCallPropertyInstruction(0x46, indexOfIndex, 1),
        Buffer.from([0x24, 0x00, 0x14]),
        writeS24(reloadBlock.length),
        reloadBlock,
        normalStatusBlock
    ]);

    patches.push({
        key: 'localization-reload-status-max-stack',
        start: methodBody.maxStackPos,
        end: methodBody.maxStackPos + 1,
        data: writeU30(4),
        detail: 'allow LinkUpdater.method_1844 to construct a URLRequest for browser localization reloads'
    });
    patches.push({
        key: 'localization-reload-status-code-length',
        start: methodBody.codeLenPos,
        end: methodBody.codeStart,
        data: writeU30(newCode.length),
        detail: 'increase LinkUpdater.method_1844 code length for localization reload handling'
    });
    patches.push({
        key: 'localization-reload-status-handler',
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: newCode,
        detail: 'hard reload in browser Flash, but ignore the hidden reload marker in standalone Flash'
    });

    return patches;
}

function buildAppendedStringPatches(abc: ReturnType<typeof parseAbc>, appendedStrings: Map<string, number>) {
    if (appendedStrings.size === 0) {
        return [];
    }

    const stringBytes = [];
    for (const value of appendedStrings.keys()) {
        const bytes = Buffer.from(value, 'utf8');
        stringBytes.push(writeU30(bytes.length), bytes);
    }

    return [
        {
            key: 'dungeonblitz-runtime-strings-count',
            start: abc.stringCountPos,
            end: abc.stringLenPositions[1],
            data: writeU30(abc.stringValues.length + appendedStrings.size),
            detail: 'increase ABC string pool count for runtime DungeonBlitz patches'
        },
        {
            key: 'dungeonblitz-runtime-strings',
            start: abc.stringPoolEndPos,
            end: abc.stringPoolEndPos,
            data: Buffer.concat(stringBytes),
            detail: 'append runtime DungeonBlitz patch strings to ABC string pool'
        }
    ];
}

export function buildDungeonBlitzSwfVariantBuffer(
    swfPath: string,
    mode: DungeonBlitzSwfMode,
    locale: DungeonBlitzSwfLocale = 'en'
): Buffer {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const patches = [];
    const appendedStrings = new Map<string, number>();
    const internString = (value: string): number => {
        const existingIndex = abc.stringValues.indexOf(value);
        if (existingIndex > 0) {
            return existingIndex;
        }
        const appendedIndex = appendedStrings.get(value);
        if (appendedIndex !== undefined) {
            return appendedIndex;
        }
        const nextIndex = abc.stringValues.length + appendedStrings.size;
        appendedStrings.set(value, nextIndex);
        return nextIndex;
    };

    for (const replacement of getReplacements(mode, locale)) {
        for (let index = 1; index < abc.stringValues.length; index++) {
            if (abc.stringValues[index] !== replacement.oldValue) {
                continue;
            }

            const replacementBytes = Buffer.from(replacement.newValue, 'utf8');
            const originalBytes = Buffer.from(replacement.oldValue, 'utf8');
            patches.push({
                key: `string:${replacement.oldValue}:${index}`,
                start: abc.stringLenPositions[index],
                end: abc.stringDataPositions[index] + originalBytes.length,
                data: Buffer.concat([writeU30(replacementBytes.length), replacementBytes]),
                detail: `${replacement.oldValue} -> ${replacement.newValue}`
            });
        }
    }

    patches.push(...buildMountedSpeedPatch(ctx));
    patches.push(...buildCharacterCreationGenderPatch(ctx, abc));
    patches.push(...buildDisconnectRefreshButtonPlacementPatch(ctx, abc));
    patches.push(...buildLocalizationReloadStatusPatch(ctx, abc, internString));
    if (locale === 'pt-br' && isBrazilianPortugueseEmotePatchEnabled()) {
        patches.push(...buildBrazilianPortugueseEmotePatches(ctx, abc, internString));
    }
    if (locale === 'pt-br') {
        patches.push(...buildBrazilianPortugueseChatChannelLabelPatches(ctx, abc, internString));
        patches.push(...buildBrazilianPortugueseChatChannelMenuLayoutPatches(ctx, abc));
        patches.push(...buildBrazilianPortugueseChatCommandMenuLabelPatches(ctx, abc, internString));
    }
    patches.push(...buildAppendedStringPatches(abc, appendedStrings));

    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    const outBody = Buffer.from(body);
    if (delta !== 0) {
        outBody.writeUInt32LE(ctx.doabcLen + delta, ctx.doabcLenFieldPos);
    }

    let finalBody: Buffer = Buffer.from(outBody);
    if (locale === 'pt-br') {
        finalBody = buildAllSwfStringReplacementBody(
            { ...ctx, body: finalBody },
            BRAZILIAN_PORTUGUESE_MAIN_SWF_UI_TEXT_REPLACEMENTS,
            finalBody
        ).body;
        finalBody = buildAllSwfStringReplacementBody(
            { ...ctx, body: finalBody },
            BRAZILIAN_PORTUGUESE_MAIN_SWF_SCRIPT_REPLACEMENTS,
            finalBody
        ).body;
        finalBody = replaceRawBytesExact(finalBody, BRAZILIAN_PORTUGUESE_MAIN_SWF_SCRIPT_REPLACEMENTS);
        finalBody = replaceSwfTagBytesInBody(finalBody, BRAZILIAN_PORTUGUESE_MAIN_SWF_TAG_REPLACEMENTS).body;
    }

    return encodeSwfBuffer(ctx, finalBody);
}
