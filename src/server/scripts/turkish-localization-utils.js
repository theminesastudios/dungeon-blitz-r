const crypto = require('crypto');

const ASCII_REPLACEMENTS = new Map([
    ['ç', 'c'], ['Ç', 'C'],
    ['ğ', 'g'], ['Ğ', 'G'],
    ['ı', 'i'], ['İ', 'I'],
    ['ö', 'o'], ['Ö', 'O'],
    ['ş', 's'], ['Ş', 'S'],
    ['ü', 'u'], ['Ü', 'U'],
    ['’', "'"], ['‘', "'"],
    ['“', '"'], ['”', '"'],
    ['…', '...']
]);

const EXACT_PHRASES = new Map(Object.entries({
    'Lost Connection': 'Baglanti Koptu',
    'Client Error': 'Istemci Hatasi',
    'Must be level': 'Seviye gerekli',
    'Busy upgrading': 'Yukseltme suruyor',
    Template: 'Sablon',
    template: 'Sablon',
    Nothing: 'Yok',
    UNUSED: 'Kullanilmiyor.',
    Temp: 'Gecici aciklama.',
    'Party Chat': 'Grup Sohbeti',
    'Guild Chat': 'Lonca Sohbeti',
    Name: 'Ad',
    Description: 'Aciklama',
    'Left': 'Sol',
    'Right': 'Sag',
    'Jump': 'Zipla',
    'Drop': 'Dus',
    'Wave': 'El Salla',
    'Dance': 'Dans',
    'Cheer': 'Tezahurat',
    'Map': 'Harita',
    'Talents': 'Yetenekler',
    'Social': 'Sosyal',
    'Inventory': 'Envanter',
    'Store': 'Magaza',
    'Door': 'Kapi',
    'Home': 'Ev',
    'Spellbook': 'Buyu Kitabi',
    'Reply': 'Yanitla',
    'Pet': 'Evcil',
    'Mount': 'Binek',
    'Paladin': 'Sovalyeci',
    'Rogue': 'Haydut',
    'Mage': 'Buyucu',
    'Adventurer': 'Maceraci',
    'Hero': 'Kahraman',
    'GuildMaster': 'Lonca Ustasi',
    'Officer': 'Subay',
    'Member': 'Uye',
    'Initiate': 'Aday',
    'Silenced': 'Susturulmus',
    'Unknown': 'Bilinmeyen',
    'Player': 'Oyuncu',
    'Dungeon': 'Zindan',
    'Dereliction of Duty': 'Gorev Ihmali',
    'Dread Dereliction of Duty': 'Dehset Gorev Ihmali',
    'Gear': 'Ekipman',
    'Loot': 'Ganimet',
    'Display': 'Gorunum',
    'Login': 'Giris',
    'Transfer': 'Aktarim',
    'Play': 'Oyna',
    'None': 'Yok',
    'Infernal': 'Cehennem',
    'Draconic': 'Ejderha',
    'Mythic': 'Efsanevi',
    'Sylvan': 'Orman',
    'Trog': 'Trog',
    'Undead': 'Olumsuz',
    'Divulgent Dragonnette': 'Acik Sozlu Kucuk Ejder',
    'Ingenious Seraph': 'Zeki Seraf',
    'Sagacious Sprite': 'Bilge Peri',
    'Banshee Scream': 'Banshee Cigligi',
    Kirin: 'Kirin Binegi',
    Longma: 'Longma Binegi',
    Mojack: 'Mojack Binegi',
    Clintt: 'Clintt Heykeli',
    Swiftness: 'Ceviklik',
    'Relic Hunting': 'Kutsal Kalinti Avciligi',
    'Gold Seeker': 'Altin Avcisi',
    Scavenging: 'Toplayicilik',
    'Swift Relic Hunt': 'Cevik Kalinti Avi',
    'Swift Gold Seek': 'Cevik Altin Avi',
    'Swift Scavenge': 'Cevik Toplayicilik',
    Forager: 'Toplayici',
    Poaching: 'Avcilik',
    Artisan: 'Zanaatkar',
    'Swift Forage': 'Cevik Toplayici',
    'Swift Poach': 'Cevik Avci',
    'Swift Artisan': 'Cevik Zanaatkar',
    'Treasure Hunter': 'Hazine Avcisi',
    'Tome of Power': 'Guc Kitabi',
    'Magic Forge': 'Buyu Ocagi',
    'Flamefury Dais': 'Alev Ofkesi Kursusu',
    'Stormgaze Refuge': 'Firtina Gozeri Siginagi',
    'Templar Citadel': 'Tapinakci Hisari',
    'Coldsnap Conduit': 'Ayaz Kanali',
    'Magmaheart Furnace': 'Magma Yuregi Firini',
    'Necromancer Tower': 'Olucagiran Kulesi',
    'Elysian Soultrap': 'Elysian Ruh Tuzagi',
    'Twisted Nethertotem': 'Carpik Nether Totemi',
    'Soulthief Lair': 'Ruh Hirsizi Ini',
    "Hero's Keep": 'Kahramanin Hisari',
    Hatchery: 'Kuluckahane',
    '+2.3% Movement Speed': '+%2.3 hareket hizi',
    '+10% Gear Finding': '+%10 ekipman bulma sansi',
    '+10% Gold Finding': '+%10 altin bulma sansi',
    '+10% Material Finding': '+%10 malzeme bulma sansi',
    '+2.3% Movement Speed, +10% Gear Finding': '+%2.3 hareket hizi, +%10 ekipman bulma sansi',
    '+2.3% Movement Speed, +10% Gold Finding': '+%2.3 hareket hizi, +%10 altin bulma sansi',
    '+2.3% Movement Speed, +10% Material Finding': '+%2.3 hareket hizi, +%10 malzeme bulma sansi',
    '+10% Gear Finding, +10% Gold Finding': '+%10 ekipman bulma sansi, +%10 altin bulma sansi',
    '+10% Gear Finding, +10% Material Finding': '+%10 ekipman bulma sansi, +%10 malzeme bulma sansi',
    '+10% Gold Finding, +10% Material Finding': '+%10 altin bulma sansi, +%10 malzeme bulma sansi',
    '+2.3% Movement Speed, +10% Gear Finding, +10% Gold Finding': '+%2.3 hareket hizi, +%10 ekipman bulma sansi, +%10 altin bulma sansi',
    '+2.3% Movement Speed, +10% Gear Finding, +10% Material Finding': '+%2.3 hareket hizi, +%10 ekipman bulma sansi, +%10 malzeme bulma sansi',
    '+2.3% Movement Speed, +10% Gold Finding, +10% Material Finding': '+%2.3 hareket hizi, +%10 altin bulma sansi, +%10 malzeme bulma sansi',
    '+10% Gear Finding, +10% Gold Finding, +10% Material Finding': '+%10 ekipman bulma sansi, +%10 altin bulma sansi, +%10 malzeme bulma sansi',
    'Respec Stone': 'Yetenek Sifirlama Tasi',
    'Resets your talent stones.': 'Yetenek taslarini sifirlar.',
    'Charm Remover': 'Tilsim Sokucu',
    'Removes a Charm from an item.': 'Bir esyadan tilsimi sokar.',
    'Potion of Gold Find': 'Altin Bulma Iksiri',
    'Potion of Material Find': 'Malzeme Bulma Iksiri',
    'Potion of XP Boost': 'XP Artis Iksiri',
    'Potion of Triple Find': 'Uclu Bulma Iksiri',
    'Potion of Gear Find': 'Ekipman Bulma Iksiri',
    'Potion of XP Boost x3': 'XP Artis Iksiri X3',
    'Potion of Material Find x3': 'Malzeme Bulma Iksiri X3',
    'Potion of Gold Find x3': 'Altin Bulma Iksiri X3',
    'Potion of Gear Find x3': 'Ekipman Bulma Iksiri X3',
    'Tinker\'s Spirit': 'Zanaatkar Ruhu',
    'Heart Furnace': 'Yurek Firini',
    'Arcane Chew Bone': 'Gizemli Cigneme Kemigi',
    'Use in Forge to guarantee a <font color=\'#0099FF\'>Rare</font> charm': "Ocakta <font color='#0099FF'>nadir</font> bir tilsimi garanti eder",
    'Use in Forge to guarantee <font color=\'#0099FF\'>Rare</font> charm and add a 50% chance to make it <font color=\'#F8DD45\'>Legendary</font>': "Ocakta <font color='#0099FF'>nadir</font> bir tilsimi garanti eder ve <font color='#F8DD45'>efsanevi</font> olmasi icin %50 sans ekler",
    'Use in Forge to guarantee a <font color=\'#F8DD45\'>Legendary</font> charm': "Ocakta <font color='#F8DD45'>efsanevi</font> bir tilsimi garanti eder",
    'Immediately gain 4000 Tinker XP': 'Hemen 4000 Zanaatkar XP kazanirsin',
    'Adds 50% to your Gold Find for 1-2 dungeons': '1-2 zindan boyunca altin bulma sansini %50 artirir',
    'Adds 50% to your Material Find for 1-2 dungeons': '1-2 zindan boyunca malzeme bulma sansini %50 artirir',
    'Adds 50% to your XP Boost for 1-2 dungeons': '1-2 zindan boyunca XP kazancini %50 artirir',
    'Adds 50% to your Gear Find for 1-2 dungeons': '1-2 zindan boyunca ekipman bulma sansini %50 artirir',
    'Adds 75% to your XP, Material and Gold Find for 1-2 dungeons': '1-2 zindan boyunca XP, malzeme ve altin bulma sansini %75 artirir',
    'Instantly revive with a Power Surge; a buff granting the user full mana and a boost in damage for a short period of time': 'Guc Dalgasi ile aninda diriltir; kisa sureligine tam mana ve hasar artisi verir',
    'Gives your pet 60,000 XP and grants your pet a level.': 'Evcilline 60.000 XP verir ve bir seviye kazandirir.',
    'Gives your pet 30,000 XP': 'Evcilline 30.000 XP verir',
    'Owls like this are said to be able to read your fate. This owl\'s big eyes study you closely.': 'Bu tur baykuslarin kaderi okuyabildigi soylenir. Bu baykus iri gozleriyle seni dikkatle inceler.',
    'Jack-Os have distinct personalities. This one seems menacing.': 'Jack-O\'larin kendine ozgu kisilikleri vardir. Bu biraz tehditkar gorunuyor.',
    'Jack-Os have distinct personalities. This one keeps staring at you with its lazy eye.': 'Jack-O\'larin kendine ozgu kisilikleri vardir. Bu kayik gozuyla surekli sana bakiyor.',
    'Jack-Os have distinct personalities. This one is happy way too much.': 'Jack-O\'larin kendine ozgu kisilikleri vardir. Bu gereginden fazla neseli.',
    'Eye of Discovery': 'Kesif Gozu',
    'Gleaming Shard': 'Parildayan Parca',
    'Shimmering Fragment': 'Isildayan Kirinti',
    'Twilight Sliver': 'Alacakaranlik Kiyimi',
    'Massive Scale': 'Dev Pul',
    'Dragon Talon': 'Ejderha Pencesi',
    'Skull of the Gods': 'Tanrilarin Kafatasi',
    'Conjured Flame': 'Cagrilmis Alev',
    'Ruby Charm': 'Yakut Tilsim',
    'Drakefire Talisman': 'Ejder Atesi Tilsimi',
    'Smooth Scales': 'Duzgun Pullar',
    'Lizard Tooth': 'Kertenkele Disi',
    'Bloodguard Bracers': 'Kan Muhafizi Bileklikleri',
    'Raptor Scales': 'Yirtici Pullari',
    'Severed Talon': 'Kopmus Pence',
    'Eye of the Wild': 'Vahsin Gozu',
    'Wyrm Tail': 'Ejder Kuyrugu',
    'Thick Hide': 'Kalin Deri',
    'Bellow Gland': 'Kukreme Bezi',
    'Unholy Sutures': 'Lanetli Dikisler',
    'Accursed Heart': 'Lanetli Kalp',
    'Maw of Madness': 'Delilik Agzi',
    'Construct Gear': 'Yapi Dislisi',
    'Construct Oil': 'Yapi Yagi',
    'Ancient Power Core': 'Kadim Guc Cekirdegi',
    'Demonic Fur': 'Iblis Kurku',
    'Brutal Horns': 'Vahsi Boynuzlar',
    'Bitter Soul': 'Aci Ruh',
    'Dread Steel': 'Dehset Celigi',
    'Ancient Emblem': 'Kadim Amblem',
    'Dreadnaught Doubloon': 'Dehset Akcesi',
    'Runed Pages': 'Runlu Sayfalar',
    'Profane Sigil': 'Kutsal Olmayan Muhur',
    'Infernal Focus': 'Cehennem Odagi',
    'Sharp Claw': 'Keskin Pence',
    'Broken Spear Tip': 'Kirik Mizrak Ucu',
    "Lucky Imp's Foot": 'Sansli Imp Ayagi',
    'Little Wing': 'Kucuk Kanat',
    'Acrid Ichor': 'Keskin Ichor',
    'Extract of the Third Eye': 'Ucuncu Goz Ozu',
    Dolcite: 'Dolsit',
    Woomerite: 'Woomerit',
    Hamilite: 'Hamilit',
    'Shade Stone': 'Golge Tasi',
    'Dark Talisman': 'Kara Tilsim',
    'Void Matter': 'Bosluk Maddesi',
    'Black Soot': 'Kara Is',
    Emberheart: 'Kor Yurek',
    'Everburning Stone': 'Sonsuz Yanan Tas',
    'Oasis Water': 'Vaha Suyu',
    "Giant's Shard": 'Dev Parcasi',
    'Moonglow Harvest': 'Ay Isigi Hasadi',
    'Brilliant Feather': 'Parlak Tuy',
    'Griffon Talon': 'Griffon Pencesi',
    'Mysterious Griffon Egg': 'Gizemli Griffon Yumurtasi',
    'Plate Steel': 'Levha Celik',
    'Defused Bomb': 'Etkisizlestirilmis Bomba',
    'Mithian Parchment': 'Mithian Parsomeni',
    'Worn Leather': 'Yipranmis Deri',
    'Imperial Talisman': 'Imparatorluk Tilsimi',
    'Lost Imperial Coin': 'Kayip Imparatorluk Sikkesi',
    'Lion Pelt': 'Aslan Postu',
    'Ring of Pride': 'Gurur Yuzugu',
    'Regal Pendant': 'Kraliyet Kolyesi',
    'Shattered Hoof': 'Parcalanmis Toynak',
    'Minotaur Horn': 'Minotor Boynuzu',
    'Golden Nosering': 'Altin Burun Halkasi',
    'Wolf Pelt': 'Kurt Postu',
    'Black Talon': 'Kara Pence',
    'Golden Earring': 'Altin Kupe',
    'Cavebat Fur': 'Magara Yarasa Kurku',
    'Bloodbat Fathom': 'Kan Yarasa Derinligi',
    'Duskwing Talons': 'Alacak Kanat Penceleri',
    'Devourer Pulp': 'Yutucu Oz',
    'Medicinal Root': 'Sifali Kok',
    'Magic Bean': 'Buyulu Fasulye',
    'Charred Bark': 'Komurlesmis Kabuk',
    'Singed Staffhead': 'Yanmis Asa Basi',
    'Wildgrowth Blossom': 'Yaban Buyume Cicegi',
    Carapace: 'Kabuk',
    'Scarab Horn': 'Bokbocegi Boynuzu',
    'Vision of the Tomb': 'Mezar Gorusu',
    'Spider Leg': 'Orumcek Bacagi',
    'Poison Gland': 'Zehir Bezi',
    'Death Silk': 'Olum Ipegi',
    'Efflorescence Roots': 'Ciceklenme Kokleri',
    'Golden Leaf': 'Altin Yaprak',
    'Seed of Seasons': 'Mevsimler Tohumu',
    'Bone Zemi Fragment': 'Kemik Zemi Parcasi',
    'Earthen Phylactery': 'Toprak Filakteri',
    'Hand of the Mountain': 'Dagin Eli',
    'Tiny Teeth': 'Minik Disler',
    'Pure Obsidilite': 'Saf Obsidilit',
    'Shadow Ring': 'Golge Yuzugu',
    'Yak Jerky': 'Kurutulmus Yak Eti',
    'Felsilk Bolt': 'Fel Ipegi Topu',
    'Onyx Goblin Dagger': 'Oniks Goblin Hanceri',
    'Silver Nugget': 'Gumus Parca',
    'Gold Nugget': 'Altin Parca',
    'Korgold Ingot': 'Korgold Kulcesi',
    'Tattered Rags': 'Yirtik Caputlar',
    'Imp Tail': 'Imp Kuyrugu',
    'Abyssal Fang': 'Ucurum Disi',
    'Tuft of Hair': 'Sac Tutami',
    'Ratling Tail': 'Ratling Kuyrugu',
    'Troglodyte Talisman': 'Troglodit Tilsimi',
    'Ivory Scale': 'Fildisi Pul',
    'Emerald Dream': 'Zumrut Ruya',
    'Stone of Whispers': 'Fisildayan Tas',
    'Chilling Air': 'Dondurucu Hava',
    'Phantom Heart': 'Hayalet Kalbi',
    'Timeworn Flax': 'Zamanla Eskimis Keten',
    'Ancient Linen': 'Kadim Keten',
    'Sand of the Ancients': 'Kadimlerin Kumu',
    'Splintered Bone': 'Kiymikli Kemik',
    'Spellbonded Femur': 'Buyu Bagli Uyluk Kemigi',
    'Laughing Skull': 'Gulen Kafatasi',
    'Aetheric Heart': 'Esir Kalbi',
    'Ethereal Strands': 'Ruhani Lifler',
    'Spirit Stone': 'Ruh Tasi',
    Ectoplasm: 'Ektoplazma',
    'Spectral Essence': 'Hayalet Ozu',
    'Vehement Netherstone': 'Siddetli Nether Tasi',
    'Candy Corn': 'Cadilar Sekeri',
    '+8% Gear Find': '+%8 ekipman bulma sansi',
    '+8% Gear Finding': '+%8 ekipman bulma sansi',
    '+8% Gold Finding;+8% Gear Find;+4% Critical Chance': '+%8 altin bulma sansi;+%8 ekipman bulma sansi;+%4 kritik sans',
    '+8% Gold Finding;+8% Gear Find': '+%8 altin bulma sansi;+%8 ekipman bulma sansi',
    '+8% Gold Finding;+4% Critical Chance': '+%8 altin bulma sansi;+%4 kritik sans',
    '+8% Gear Find;+4% Critical Chance': '+%8 ekipman bulma sansi;+%4 kritik sans'
}));

const PROPER_PHRASES = new Map(Object.entries({
    'Jade City': 'Yesim Sehir',
    'JadeCity': 'Yesim Sehir',
    'Newbie Road': 'Acemi Yolu',
    'NewbieRoad': 'Acemi Yolu',
    "Wolf's End": 'Kurtlarin Sonu',
    'Wolfs End': 'Kurtlarin Sonu',
    'WolfsEnd': 'Kurtlarin Sonu',
    'Black Rose Mire': 'Siyah Gul Batakligi',
    'BlackRoseMire': 'Siyah Gul Batakligi',
    'Capstone': 'Kilit Tasi',
    'The Capstone': 'Kilit Tasi',
    'Dread Capstone': 'Dehset Kilit Tasi',
    'Bridge Town': 'Kopru Kasabasi',
    'BridgeTown': 'Kopru Kasabasi',
    'Cemetery Hill': 'Mezarlik Tepesi',
    'CemeteryHill': 'Mezarlik Tepesi',
    'Old Mine Mountain': 'Eski Maden Dagi',
    'OldMineMountain': 'Eski Maden Dagi',
    'Emerald Glades': 'Zumrut Cayirlari',
    'EmeraldGlades': 'Zumrut Cayirlari',
    'Stormshard Mountain': 'Firtina Tasi Dagi',
    'Stormshard Mountains': 'Firtina Tasi Daglari',
    'Stormshard Peaks': 'Firtina Tasi Zirveleri',
    'Stormshard': 'Firtina Tasi',
    'Shazari Desert': 'Shazari Colu',
    'ShazariDesert': 'Shazari Colu',
    'Castle Hocke': 'Hocke Kalesi',
    'Castle': 'Kale',
    'Deepgard': 'Derinkoruma',
    'Felbridge': 'Fel Koprusu',
    'Valhaven': 'Val Limani',
    'Wolf': 'Kurt',
    'Meylour': 'Meylour',
    'Nephit': 'Nephit',
    'Hocke': 'Hocke',
    'Titus': 'Titus',
    'Yagaga': 'Yagaga',
    'Pappy': 'Pappy',
    'Arachnae': 'Arachnae',
    'Svars': 'Svar',
    'Svagg': 'Svagg',
    'Kamak': 'Kamak'
}));

const WORDS = new Map(Object.entries({
    a: 'bir',
    an: 'bir',
    the: '',
    and: 've',
    or: 'veya',
    of: '',
    to: '',
    in: 'icinde',
    on: 'uzerinde',
    for: 'icin',
    from: 'kaynakli',
    with: 'ile',
    without: 'olmadan',
    your: 'senin',
    you: 'sen',
    me: 'beni',
    my: 'benim',
    our: 'bizim',
    all: 'tum',
    every: 'her',
    no: 'yok',
    not: 'degil',
    more: 'daha',
    less: 'daha az',
    new: 'yeni',
    old: 'eski',
    great: 'buyuk',
    greater: 'daha buyuk',
    small: 'kucuk',
    hard: 'zor',
    normal: 'normal',
    dread: 'dehset',
    ancient: 'kadim',
    magic: 'buyu',
    magical: 'buyulu',
    power: 'guc',
    powers: 'gucler',
    ability: 'yetenek',
    abilities: 'yetenekler',
    skill: 'beceri',
    skills: 'beceriler',
    talent: 'yetenek',
    talents: 'yetenekler',
    tree: 'agac',
    level: 'seviye',
    levels: 'seviyeler',
    upgrade: 'yukselt',
    upgrades: 'yukseltmeler',
    damage: 'hasar',
    attack: 'saldiri',
    attacks: 'saldirilar',
    armor: 'zirh',
    health: 'can',
    mana: 'mana',
    recovery: 'toparlanma',
    haste: 'hiz',
    chance: 'sans',
    critical: 'kritik',
    crit: 'kritik',
    resist: 'direnc',
    resilience: 'dayaniklilik',
    melee: 'yakin dovus',
    ranged: 'menzilli',
    range: 'menzil',
    magicdmg: 'buyu hasari',
    fire: 'ates',
    frost: 'buz',
    ice: 'buz',
    shadow: 'golge',
    light: 'isik',
    blood: 'kan',
    poison: 'zehir',
    spirit: 'ruh',
    spirits: 'ruhlar',
    ghost: 'hayalet',
    ghosts: 'hayaletler',
    goblin: 'goblin',
    goblins: 'goblinler',
    dragon: 'ejderha',
    dragons: 'ejderhalar',
    spider: 'orumcek',
    spiders: 'orumcekler',
    lizard: 'kertenkele',
    undead: 'olumsuz',
    human: 'insan',
    humans: 'insanlar',
    monster: 'canavar',
    monsters: 'canavarlar',
    boss: 'patron',
    dungeon: 'zindan',
    dungeons: 'zindanlar',
    mission: 'gorev',
    missions: 'gorevler',
    quest: 'gorev',
    quests: 'gorevler',
    reward: 'odul',
    rewards: 'oduller',
    gold: 'altin',
    idol: 'idol',
    item: 'esya',
    items: 'esyalar',
    gear: 'ekipman',
    weapon: 'silah',
    weapons: 'silahlar',
    sword: 'kilic',
    bow: 'yay',
    staff: 'asa',
    robe: 'cubbe',
    boots: 'cizmeler',
    gloves: 'eldivenler',
    helm: 'migfer',
    helmet: 'migfer',
    ring: 'yuzuk',
    charm: 'tilsim',
    charms: 'tilsimlar',
    chipped: 'yontuk',
    dim: 'soluk',
    streaked: 'cizgili',
    unflawed: 'kusursuz',
    superb: 'muhtesem',
    stunning: 'goz alici',
    radiant: 'isik sacan',
    celestial: 'goksel',
    goddess: 'tanrica',
    infinite: 'sonsuz',
    diamond: 'elmas',
    amethyst: 'ametist',
    topaz: 'topaz',
    zircon: 'zirkon',
    ruby: 'yakut',
    emerald: 'zumrut',
    citrine: 'sitrin',
    sapphire: 'safir',
    onyx: 'oniks',
    finding: 'bulma sansi',
    find: 'bul',
    shard: 'parca',
    fragment: 'kirinti',
    sliver: 'kiyim',
    material: 'malzeme',
    materials: 'malzemeler',
    pet: 'evcil',
    pets: 'evciller',
    mount: 'binek',
    mounts: 'binekler',
    store: 'magaza',
    royal: 'kraliyet',
    lockbox: 'kilitli sandik',
    consumable: 'tuketilebilir',
    statue: 'heykel',
    egg: 'yumurta',
    dye: 'boya',
    color: 'renk',
    black: 'siyah',
    white: 'beyaz',
    red: 'kirmizi',
    blue: 'mavi',
    green: 'yesil',
    yellow: 'sari',
    purple: 'mor',
    orange: 'turuncu',
    silver: 'gumus',
    golden: 'altin',
    dark: 'koyu',
    bright: 'parlak',
    deep: 'derin',
    stone: 'tas',
    crystal: 'kristal',
    crystals: 'kristaller',
    dream: 'ruya',
    dreams: 'ruyalar',
    sleeping: 'uyuyan',
    lands: 'topraklar',
    road: 'yol',
    city: 'sehir',
    town: 'kasaba',
    bridge: 'kopru',
    swamp: 'bataklik',
    river: 'nehir',
    hill: 'tepe',
    mountain: 'dag',
    mine: 'maden',
    desert: 'col',
    castle: 'kale',
    cemetery: 'mezarlik',
    glade: 'cayir',
    glades: 'cayirlar',
    temple: 'tapinak',
    tower: 'kule',
    keep: 'hisar',
    king: 'kral',
    queen: 'kralice',
    emperor: 'imparator',
    baron: 'baron',
    captain: 'kaptan',
    mayor: 'baskan',
    master: 'usta',
    apprentice: 'cirak',
    slayer: 'avci',
    killer: 'olduren',
    kill: 'oldur',
    kills: 'oldurmeler',
    slay: 'avla',
    defeat: 'yen',
    defeated: 'yenildi',
    complete: 'tamamla',
    completed: 'tamamlandi',
    collect: 'topla',
    find: 'bul',
    open: 'ac',
    close: 'kapat',
    enter: 'gir',
    leave: 'ayril',
    return: 'don',
    talk: 'konus',
    protect: 'koru',
    save: 'kurtar',
    help: 'yardim',
    destroy: 'yok et',
    stop: 'durdur',
    use: 'kullan',
    summon: 'cagir',
    summons: 'cagirir',
    strike: 'vurus',
    blade: 'bicak',
    blades: 'bicaklar',
    shot: 'atis',
    shots: 'atislar',
    arrow: 'ok',
    arrows: 'oklar',
    bolt: 'ok',
    blast: 'patlama',
    wave: 'dalga',
    storm: 'firtina',
    shield: 'kalkan',
    barrier: 'bariyer',
    aura: 'aura',
    form: 'form',
    trap: 'tuzak',
    bomb: 'bomba',
    rage: 'ofke',
    focus: 'odak',
    wisdom: 'bilgelik',
    strength: 'guc',
    agility: 'ceviklik',
    dexterity: 'ceviklik',
    intelligence: 'zeka',
    expertise: 'uzmanlik',
    stat: 'istatistik',
    stats: 'istatistikler',
    score: 'puan',
    accuracy: 'isabet',
    time: 'sure',
    remaining: 'kalan',
    busy: 'mesgul',
    requires: 'gerektirir',
    required: 'gerekli',
    enough: 'yeterli',
    locked: 'kilitli',
    unlocked: 'acildi',
    available: 'mevcut',
    learn: 'ogren',
    learned: 'ogrenildi',
    cost: 'bedel',
    free: 'serbest',
    buy: 'satın al',
    sell: 'sat',
    equip: 'kusat',
    equipped: 'kusatilmis',
    unequip: 'cikar',
    craft: 'uret',
    crafting: 'uretim',
    rare: 'nadir',
    epic: 'destansi',
    common: 'yaygin',
    uncommon: 'sira disi',
    legendary: 'efsanevi'
}));

const POWER_DISPLAY_PHRASES = new Map(Object.entries({
    'Sword Melee': 'Kilic Yakin Dovus',
    'Mace Melee': 'Gurz Yakin Dovus',
    'Axe Melee': 'Balta Yakin Dovus',
    'Dagger Melee': 'Hancer Yakin Dovus',
    'Staff Melee': 'Asa Yakin Dovus',
    Lightningball: 'Simsek Kuresi',
    Energyball: 'Enerji Kuresi',
    Fireball: 'Ates Topu',
    Iceball: 'Buz Kuresi',
    Poisonball: 'Zehir Kuresi',
    Smash: 'Ezici Darbe',
    Skewer: 'Saplama',
    Cleave: 'Yarici Darbe',
    'Healing Touch': 'Sifa Dokunusu',
    Warcry: 'Savas Cigligi',
    'Shield Stun': 'Kalkan Sersemletmesi',
    'Aura of Blessing': 'Kutsama Aurasi',
    'Guardian Shield': 'Muhafiz Kalkani',
    'Jump Slam': 'Sicrama Darbesi',
    'Divine Bolt': 'Ilahi Ok',
    'Divine Word': 'Ilahi Soz',
    Subjugate: 'Boyun Egdir',
    'Hallowed Reckoning': 'Kutsal Hesaplasma',
    Penance: 'Kefaret',
    Verdict: 'Hukum',
    'Empyrean Aura': 'Goksel Aura',
    Sanctum: 'Kutsal Alan',
    'Celestial Lance': 'Goksel Mizrak',
    'Sacred Light': 'Kutsal Isik',
    'Axe Flurry': 'Balta Firtinasi',
    'Pain Eater': 'Aci Yiyen',
    'End Pain Eater': 'Aci Yiyeni Bitir',
    Sacrifice: 'Fedakarlik',
    'End Sacrifice': 'Fedakarligi Bitir',
    'Furious Assault': 'Ofkeli Saldiri',
    'Justice Fist': 'Adalet Yumrugu',
    'Cleaving Blows': 'Yarici Darbeler',
    Fury: 'Hiddet',
    'Flame Axe': 'Alev Baltasi',
    'Lightning Storm': 'Simsek Firtinasi',
    'Lightning Bomb': 'Simsek Bombasi',
    Harm: 'Zarar',
    Berserker: 'Cengaver',
    'Meteor Smash': 'Meteor Darbesi',
    'Fire Shield': 'Ates Kalkani',
    Heroism: 'Kahramanlik',
    Blaze: 'Alev',
    'Concussion Bolt': 'Sarsinti Oku',
    'Holy Smash': 'Kutsal Darbe',
    'Shield Flurry': 'Kalkan Firtinasi',
    Retribution: 'Intikam',
    Shockwave: 'Sok Dalgasi',
    'Unstable Barrier': 'Dengesiz Bariyer',
    Juggernaut: 'Ezici Guc',
    'Second Wind': 'Ikinci Nefes',
    Defiance: 'Meydan Okuma',
    'Sentinel Form': 'Gozcu Formu',
    'End Sentinel Form': 'Gozcu Formunu Bitir',
    'Fire Blast': 'Ates Patlamasi',
    'Ice Lance': 'Buz Mizragi',
    'Vine Strike': 'Sarmasik Darbesi',
    'Vine Lance': 'Sarmasik Mizragi',
    'Flame Wave': 'Alev Dalgasi',
    'Ice Nova': 'Buz Novasi',
    'Poison Cloud': 'Zehir Bulutu',
    'Meteor Channel': 'Meteor Odaklamasi',
    Meteor: 'Goktasi',
    'Hail Storm': 'Dolu Firtinasi',
    'Call Guard': 'Muhafiz Cagir',
    'Frost Bolt': 'Don Oku',
    'Frigid Comet': 'Dondurucu Kuyruklu Yildiz',
    'Frozen Ward': 'Donmus Muhur',
    'Arctic Blast': 'Kutup Patlamasi',
    'Hailstone Embrace': 'Dolu Sarmali',
    'End Hailstone Embrace': 'Dolu Sarmalini Bitir',
    'Frost Spire': 'Buz Kulesi',
    'Glacial Spear': 'Buzul Mizragi',
    'Permafrost Clone': 'Kalici Buz Klonu',
    'Tundra Wyrm': 'Tundra Ejderi',
    'Bitter Blade': 'Acimasiz Bicak',
    Inferno: 'Cehennem Alevi',
    Conflagration: 'Buyuk Yangin',
    'Molten Rain': 'Erimis Yagmur',
    'Draconic Soul': 'Ejderha Ruhu',
    'Fire Ball': 'Ates Topu',
    'Searing Grasp': 'Yakici Kavrayis',
    Pyromania: 'Piromani',
    Wildfire: 'Yaban Alevi',
    WildFire: 'Yaban Alevi',
    Firebrand: 'Alev Damgasi',
    'Iridescent Burst': 'Yanardoner Patlama',
    'Molten Fist': 'Erimis Yumruk',
    'Lich Shot': 'Lich Atisi',
    'Call the Horde': 'Suruyu Cagir',
    'Bolster the Horde': 'Suruyu Guclendir',
    Desecrate: 'Kirlet',
    Infestation: 'Istila',
    'Death Mark': 'Olum Isareti',
    'Spectral Grasp': 'Hayalet Kavrayisi',
    Lifethirst: 'Can Susuzlugu',
    'Wail of the Banshee': 'Banshee Cigligi',
    'Plague Battalion': 'Veba Taburu',
    'Stun Strike': 'Sersemletme Darbesi',
    'Poison Strike': 'Zehir Darbesi',
    'Triple Strike': 'Uclu Darbe',
    Weaken: 'Zayiflat',
    Entanglement: 'Dolanma',
    'Steel Whirlwind': 'Celik Kasirga',
    'Hawk Strike': 'Sahin Darbesi',
    'Armor Breaker': 'Zirh Kiran',
    'Reduce Armor': 'Zirhi Azalt',
    'Slapdash Decoy': 'Derme Catma Sahte Hedef',
    Decoy: 'Sahte Hedef',
    'Bone Daggers': 'Kemik Hancerler',
    'Flurry of Daggers': 'Hancer Firtinasi',
    'Severing Strike': 'Koparan Darbe',
    "Scorpion's Sting": 'Akrep Ignesi',
    'Crimson Butterfly': 'Kizil Kelebek',
    'Withering Impact': 'Solduran Darbe',
    Assassinate: 'Suikast',
    'Mist Walk': 'Sis Yuruyusu',
    'Vicious Assault': 'Acimasiz Saldiri',
    'Shadow Rend': 'Golge Yirtisi',
    "Charon's Blades": 'Charon Bicaklari',
    'Heavy Daggers': 'Agir Hancerler',
    Devour: 'Yut',
    'Hex Blade': 'Lanet Bicagi',
    'Chaos Wave': 'Kaos Dalgasi',
    "Butcher's Boon": 'Kasabin Lutufu',
    'Shadow Scythe': 'Golge Tirpani',
    'Necrotic Surge': 'Nekrotik Dalga',
    'Ghost Blade': 'Hayalet Bicak',
    'Soul Reaver': 'Ruh Bicici',
    Carnifex: 'Cellat',
    'Rolling Vines': 'Yuvarlanan Sarmasiklar',
    'AoE Melee': 'Alan Yakin Dovus',
    'Shadow Step': 'Golge Adimi',
    'Daggers Of Affliction': 'Eziyet Hancerleri',
    'Corrosive Dagger': 'Asindirici Hancer',
    'Heart Seeker': 'Kalp Avcisi',
    'Dark Chi': 'Kara Chi',
    'False Chi': 'Sahte Chi',
    'Shadow Legion': 'Golge Lejyonu',
    'Midnight Shroud': 'Gece Yarisi Ortusu',
    'Withering Mist': 'Solduran Sis',
    'Black Miasma': 'Kara Miasma',
    'Black Storm': 'Kara Firtina',
    Arcanum: 'Arkanum',
    Swiftfoot: 'Cevik Ayak',
    'Mending Blow': 'Onarici Darbe',
    Mythbane: 'Mit Avcisi',
    Trogbane: 'Trog Avcisi',
    Demonbane: 'Iblis Avcisi',
    Forestbane: 'Orman Avcisi',
    Dragonbane: 'Ejderha Avcisi',
    Ghostbane: 'Hayalet Avcisi',
    Blizzard: 'Tipi',
    Incinerate: 'Yakip Kul Et',
    Lifebane: 'Yasam Dusmani',
    Deathdealer: 'Olum Dagitan',
    Typhoon: 'Tayfun',
    Earthshaker: 'Yer Sarsan',
    Renew: 'Yenile',
    'Heavy Blow': 'Agir Darbe',
    Hemorrhage: 'Kanama',
    'Attack Speed': 'Saldiri Hizi',
    Tenacity: 'Metanet',
    'Air Slayer': 'Hava Avcisi',
    'Earth Slayer': 'Toprak Avcisi',
    'Fire Slayer': 'Ates Avcisi',
    'Life Slayer': 'Yasam Avcisi',
    'Ice Slayer': 'Buz Avcisi',
    'Death Slayer': 'Olum Avcisi',
    'Critical Chance': 'Kritik Sans',
    'Critical Power': 'Kritik Guc',
    'Health Bonus': 'Can Bonusu',
    'Recovery Bonus': 'Toparlanma Bonusu',
    'Resist Air': 'Hava Direnci',
    'Resist Earth': 'Toprak Direnci',
    'Resist Fire': 'Ates Direnci',
    'Resist Life': 'Yasam Direnci',
    'Resist Ice': 'Buz Direnci',
    'Resist Death': 'Olum Direnci',
    Mythward: 'Mit Muhafazasi',
    Trogward: 'Trog Muhafazasi',
    Demonward: 'Iblis Muhafazasi',
    Forestward: 'Orman Muhafazasi',
    Dragonward: 'Ejderha Muhafazasi',
    Ghostward: 'Hayalet Muhafazasi',
    Dismount: 'Binekten In',
    'Summon Wolf Bear': 'Kurt Ayi Cagir',
    'Summon Pet': 'Evcil Cagir',
    'Dismiss Pet': 'Evcili Gonder',
    'Proc Life Rob': 'Can Calma Tetikle',
    'Summon Pet Jack-O': 'Jack-O Evcili Cagir',
    'Summon Pet Gargoyle': 'Gargoyle Evcili Cagir',
    'Summon Dragonette': 'Kucuk Ejder Cagir',
    'Summon Spirit': 'Ruh Cagir',
    'Summon Skull': 'Kafatasi Cagir',
    '***Monster***': '***Canavar***',
    '***MonsterProc***': '***CanavarTetik***'
}));

const POWER_WORDS = new Map(Object.entries({
    acid: 'asit',
    accelerant: 'hizlandirici',
    affliction: 'eziyet',
    air: 'hava',
    ally: 'muttefik',
    allies: 'muttefikler',
    aoe: 'alan etkisi',
    area: 'alan',
    applies: 'uygular',
    apply: 'uygula',
    arctic: 'kutup',
    artery: 'atardamar',
    assault: 'saldiri',
    attack: 'saldiri',
    attacks: 'saldirilar',
    bane: 'kirici',
    banshee: 'banshee',
    basic: 'temel',
    bash: 'darbe',
    battalion: 'tabur',
    bind: 'baglama',
    binding: 'baglama',
    bite: 'isirik',
    bitter: 'aci',
    bladed: 'bicakli',
    blains: 'yaralar',
    blessed: 'kutsanmis',
    blessing: 'kutsama',
    bleed: 'kanama',
    bleeding: 'kanayan',
    blind: 'kor et',
    blinds: 'kor eder',
    blinding: 'kor eden',
    blinded: 'kor',
    blizzard: 'tipi',
    blow: 'darbe',
    blows: 'darbeler',
    bolster: 'guclendir',
    bomb: 'bomba',
    bone: 'kemik',
    boon: 'lutfu',
    bonus: 'bonus',
    bound: 'bagli',
    boost: 'artis',
    boosts: 'artirir',
    breaker: 'kiran',
    breaking: 'kirilma',
    briefly: 'kisa sure',
    burn: 'yanma',
    burning: 'yanan',
    burst: 'patlama',
    butcher: 'kasap',
    call: 'cagir',
    carnifex: 'cellat',
    casket: 'tabut',
    cast: 'kullanim',
    casting: 'kullanmak',
    chance: 'sans',
    celestial: 'goksel',
    channel: 'kanal',
    charon: 'charon',
    chill: 'sogutma',
    chilled: 'sogutulmus',
    chilblains: 'soguk yaralari',
    chi: 'chi',
    cleanse: 'arindir',
    cleansing: 'arindirici',
    cleaving: 'yarici',
    cloak: 'pelerin',
    clone: 'klon',
    clutch: 'son anda',
    cold: 'soguk',
    comet: 'kuyruklu yildiz',
    combo: 'kombo',
    concentrated: 'yogun',
    condition: 'kosul',
    conditions: 'kosullar',
    concussion: 'sarsma',
    conflagration: 'buyuk yangin',
    conserve: 'koru',
    contact: 'temas',
    cooldown: 'bekleme',
    corrosive: 'asindirici',
    crippling: 'sakatlayan',
    cripple: 'sakatla',
    crippled: 'sakatlanmis',
    cripples: 'sakatlar',
    criticals: 'kritikler',
    curse: 'lanet',
    cursed: 'lanetli',
    cuts: 'kesikler',
    daze: 'afallat',
    dazes: 'afallatir',
    daggers: 'hancerler',
    dash: 'atilma',
    dashing: 'atilma',
    damage: 'hasar',
    damages: 'hasar verir',
    damaging: 'hasar veren',
    daybreak: 'safak',
    deal: 'ver',
    dealer: 'dagitan',
    deals: 'verir',
    death: 'olum',
    debuff: 'zayiflatma',
    debuffs: 'zayiflatmalar',
    decoy: 'sahte hedef',
    decrease: 'azalt',
    decreases: 'azaltir',
    defense: 'savunma',
    defiance: 'meydan okuma',
    demoralizing: 'moral bozan',
    desecrate: 'kirlet',
    devour: 'yut',
    divine: 'ilahi',
    doom: 'kiyamet',
    dot: 'zamanla hasar',
    draconic: 'ejderha',
    drain: 'tuketim',
    dry: 'kuru',
    duration: 'sure',
    earth: 'toprak',
    eater: 'yiyen',
    edge: 'kenar',
    effectiveness: 'etki',
    effect: 'etki',
    elemental: 'element',
    embrace: 'sarmal',
    enemies: 'dusmanlar',
    enemy: 'dusman',
    energy: 'enerji',
    enfeeble: 'gucsuzlestirme',
    entering: 'giris',
    ethereal: 'ruhani',
    extra: 'ek',
    fall: 'dus',
    false: 'sahte',
    fervor: 'cosku',
    firebrand: 'alev damgasi',
    fist: 'yumruk',
    flurry: 'firtina',
    foe: 'dusman',
    foes: 'dusmanlar',
    form: 'form',
    fortify: 'guclendir',
    freeze: 'dondurma',
    frigid: 'dondurucu',
    friend: 'dost',
    friends: 'dostlar',
    frostbite: 'don isirigi',
    gain: 'kazan',
    gains: 'kazanir',
    generation: 'uretimi',
    ghoul: 'ghoul',
    glacial: 'buzul',
    grants: 'verir',
    grasp: 'kavrayis',
    greater: 'buyuk',
    guard: 'muhafiz',
    guardian: 'muhafiz',
    hallowed: 'kutsal',
    hail: 'dolu',
    hailstone: 'dolu',
    hamstring: 'topallatma',
    harmony: 'uyum',
    hate: 'nefret',
    heal: 'iyilestir',
    heals: 'iyilestirir',
    healing: 'iyilestirme',
    heavy: 'agir',
    hemorrhage: 'kanama',
    heroism: 'kahramanlik',
    hex: 'lanet',
    hit: 'vurus',
    hits: 'vuruslar',
    horde: 'suru',
    hp: 'can',
    ice: 'buz',
    ignite: 'tutustur',
    ignited: 'tutusmus',
    ignites: 'tutusturur',
    igniting: 'tutusturur',
    immobilized: 'hareketsiz',
    impact: 'etki',
    incinerate: 'yakip kul et',
    increase: 'artir',
    increased: 'artan',
    increases: 'artirir',
    inferno: 'cehennem alevi',
    infestation: 'istila',
    insidious: 'sinsi',
    intensity: 'yogunluk',
    iridescent: 'yanardoner',
    jab: 'saplama',
    jabs: 'saplamalar',
    justice: 'adalet',
    lance: 'mizrak',
    last: 'son',
    lesser: 'kucuk',
    lich: 'lich',
    life: 'yasam',
    lifethirst: 'yasam susuzlugu',
    lingering: 'kalici',
    mana: 'mana',
    melee: 'yakin dovus',
    mark: 'isaret',
    mastery: 'ustalik',
    maximum: 'azami',
    mending: 'onarici',
    meteor: 'meteor',
    miasma: 'miasma',
    midnight: 'gece yarisi',
    minion: 'hizmetkar',
    minions: 'hizmetkarlar',
    mist: 'sis',
    molten: 'erimis',
    multi: 'coklu',
    mythbane: 'mit avcisi',
    napalm: 'napalm',
    nearby: 'yakindaki',
    necrotic: 'nekrotik',
    nerve: 'sinir',
    nova: 'nova',
    number: 'sayi',
    opponent: 'rakip',
    opponents: 'rakipler',
    opportunist: 'firsatci',
    overtime: 'zamanla',
    pain: 'aci',
    party: 'grup',
    pause: 'duraklama',
    pauses: 'duraklatir',
    penalty: 'ceza',
    percent: 'yuzde',
    penance: 'kefaret',
    permafrost: 'kalici don',
    pierce: 'del',
    piercing: 'delici',
    plague: 'veba',
    poison: 'zehir',
    poisoned: 'zehirlenmis',
    pounce: 'sicrayis',
    proc: 'tetik',
    projectile: 'mermi',
    projectiles: 'mermiler',
    pyromania: 'piromani',
    quick: 'hizli',
    raised: 'yukseldi',
    rapid: 'hizli',
    range: 'menzil',
    ranged: 'menzilli',
    reckoning: 'hesaplasma',
    reduce: 'azalt',
    reduces: 'azaltir',
    reducing: 'azaltir',
    refuge: 'siginak',
    regeneration: 'yenilenme',
    rend: 'yirtis',
    reaver: 'bicici',
    rob: 'calma',
    root: 'kok',
    roots: 'kok salar',
    sacred: 'kutsal',
    sanctify: 'kutsalla',
    scorpion: 'akrep',
    scorch: 'kavurma',
    scythe: 'tirpan',
    searing: 'yakici',
    second: 'saniye',
    seconds: 'saniye',
    sentinel: 'nobetci',
    shatter: 'parcala',
    shield: 'kalkan',
    shots: 'atislar',
    shroud: 'ortu',
    siphon: 'emme',
    slam: 'sert darbe',
    slapdash: 'derme catma',
    slowed: 'yavaslamis',
    soul: 'ruh',
    spear: 'mizrak',
    spectral: 'ruhani',
    spire: 'kule',
    stack: 'yuk',
    stacks: 'yukler',
    stagger: 'sars',
    staggered: 'sarsilmis',
    staggering: 'sarsan',
    staggers: 'sarsar',
    steadiness: 'denge',
    steel: 'celik',
    sting: 'igne',
    strike: 'darbe',
    strikes: 'darbeler',
    stunned: 'sersemlemis',
    stun: 'sersemlet',
    stuns: 'sersemletir',
    subjugate: 'boyun egdir',
    surge: 'dalga',
    swiftfoot: 'cevik ayak',
    taunt: 'kiskirt',
    taunting: 'kiskirtan',
    tenacious: 'inatci',
    target: 'hedef',
    targets: 'hedefler',
    thirst: 'susuzluk',
    thrust: 'hamle',
    touch: 'dokunus',
    transferred: 'aktarilan',
    triple: 'uclu',
    tundra: 'tundra',
    twisted: 'carpik',
    unleash: 'serbest birak',
    unstable: 'dengesiz',
    venom: 'zehir',
    verdict: 'hukum',
    vicious: 'acimasiz',
    vigor: 'dinclik',
    volatile: 'ucucu',
    vulnerable: 'savunmasiz',
    wail: 'ciglik',
    walk: 'yuruyus',
    ward: 'muhafaza',
    weakened: 'zayiflatilmis',
    whirlwind: 'kasirga',
    wildfire: 'kontrolsuz ates',
    wind: 'ruzgar',
    within: 'icindeki',
    wounded: 'yarali',
    wyrm: 'ejder',
    zeal: 'cosku'
}));

function normalizeAscii(value) {
    return String(value ?? '').replace(/[çÇğĞıİöÖşŞüÜ’‘“”…]/g, (char) => ASCII_REPLACEMENTS.get(char) || char);
}

function hasEnglishLetters(value) {
    return /[A-Za-z]{2,}/.test(String(value ?? ''));
}

function stableId(value) {
    return crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 6).toUpperCase();
}

function titleCaseAscii(value) {
    return normalizeAscii(value)
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function splitCamelToken(token) {
    return String(token ?? '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ');
}

function translateWord(rawWord) {
    const word = String(rawWord ?? '');
    if (!word) {
        return word;
    }

    if (/^#\w+#$/.test(word)) {
        return word;
    }

    const exact = EXACT_PHRASES.get(word) || PROPER_PHRASES.get(word);
    if (exact) {
        return exact;
    }

    const split = splitCamelToken(word);
    if (split !== word && /\s/.test(split)) {
        const translated = split
            .split(/\s+/)
            .map((part) => translateWord(part))
            .filter(Boolean)
            .join(' ');
        if (translated) {
            return translated;
        }
    }

    const lower = word.toLowerCase().replace(/'s$/i, '');
    let mapped;
    if (POWER_WORDS.has(lower)) {
        mapped = POWER_WORDS.get(lower);
    } else if (WORDS.has(lower)) {
        mapped = WORDS.get(lower);
    } else {
        mapped = EXACT_PHRASES.get(lower) || PROPER_PHRASES.get(lower);
    }
    if (mapped !== undefined) {
        return mapped;
    }

    if (/^\d+$/.test(word)) {
        return word;
    }

    return splitCamelToken(word);
}

function applyPhraseGlossary(value) {
    let next = String(value ?? '');
    const phrases = [...PROPER_PHRASES.entries(), ...EXACT_PHRASES.entries()]
        .sort((a, b) => b[0].length - a[0].length);

    for (const [source, target] of phrases) {
        next = next.replace(new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), target);
    }

    return next;
}

function translateTokenized(value, options = {}) {
    const source = String(value ?? '');
    const phraseApplied = applyPhraseGlossary(source);
    const tokens = phraseApplied.match(/#\w+#|[A-Za-z][A-Za-z0-9']*|\d+|[^A-Za-z0-9#]+|#/g) || [];
    const out = [];

    for (const token of tokens) {
        if (/^[A-Za-z][A-Za-z0-9']*$/.test(token) || /^#\w+#$/.test(token)) {
            const translated = translateWord(token);
            if (translated) {
                out.push(translated);
            }
            continue;
        }
        out.push(token);
    }

    let translated = out.join('')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/([([{])\s+/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (!translated || !hasEnglishLetters(translated)) {
        translated = translated || fallbackText(source, options);
    }

    return normalizeAscii(translated);
}

function isPowerTextContext(options = {}) {
    const root = String(options.rootName || '');
    return /Power|Ability/.test(root);
}

function cleanPowerText(value) {
    const text = normalizeAscii(value)
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/([([{])\s+/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+$/g, '')
        .trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function localizePowerDisplayName(source) {
    const value = String(source ?? '').trim();
    const compactValue = value.replace(/\s+/g, ' ');
    if (!value || /^[-*]+$/.test(value)) {
        return normalizeAscii(value);
    }

    const modExact = POWER_MOD_LABELS.get(value) || POWER_MOD_LABELS.get(compactValue);
    if (modExact) {
        return normalizeAscii(modExact);
    }

    const exact = POWER_DISPLAY_PHRASES.get(value) || POWER_DISPLAY_PHRASES.get(compactValue);
    if (exact) {
        return normalizeAscii(exact);
    }

    const translated = translateTokenized(value, { rootName: 'PlayerPowerTypes', tagName: 'DisplayName' });
    return titleCaseAscii(cleanPowerText(translated || value));
}

function localizePowerLabel(source) {
    const value = String(source ?? '').trim();
    if (!value) {
        return value;
    }

    const modExact = POWER_MOD_LABELS.get(value) || POWER_MOD_LABELS.get(value.replace(/\s+/g, ' '));
    if (modExact) {
        return normalizeAscii(modExact);
    }

    const exact = POWER_DISPLAY_PHRASES.get(value) || EXACT_PHRASES.get(value) || PROPER_PHRASES.get(value);
    if (exact) {
        return normalizeAscii(exact);
    }

    return titleCaseAscii(cleanPowerText(translateTokenized(value, { rootName: 'PowerModTypes', tagName: 'DisplayName' })));
}

function localizePowerStatSegment(source) {
    const value = String(source ?? '');
    return value.replace(/^(\s*)([^:,@]+)([:,])/, (_match, leading, label, punctuation) => {
        return `${leading}${localizePowerLabel(label)}${punctuation}`;
    });
}

const POWER_MOD_LABELS = new Map(Object.entries({
    'Lesser Recovery': 'Kucuk Toparlanma',
    'Greater Recovery': 'Buyuk Toparlanma',
    'Master Recovery': 'Usta Toparlanma',
    'Artery Strike': 'Atardamar Darbesi',
    'Deep Cuts': 'Derin Kesikler',
    'Concentrated Venom': 'Yogun Zehir',
    'Contact Poison': 'Temas Zehri',
    'Corrosive Strikes': 'Asindirici Darbeler',
    'Acid Edge': 'Asitli Keskinlik',
    Steadiness: 'Denge',
    Hemorrhage: 'Kanama',
    'Element Mastery': 'Element Ustaligi',
    'Heavy Blows': 'Agir Darbeler',
    'Nerve Strike': 'Sinir Darbesi',
    'Bind Strength': 'Gucu Bagla',
    Hamstring: 'Topallatma',
    'Bone Breaker': 'Kemik Kiran',
    Pounce: 'Atlama',
    Ethereal: 'Ruhani',
    Opportunist: 'Firsatci',
    'Shadow Refuge': 'Golge Siginagi',
    Immolation: 'Yakma',
    Volatile: 'Uctucu',
    Fury: 'Hiddet',
    'Pain Eater': 'Aci Yiyen',
    'Fire Shield': 'Ates Kalkani',
    Heroism: 'Kahramanlik',
    Vigor: 'Dinclik',
    Taunt: 'Kiskirtma',
    Blessed: 'Kutsanmis',
    Zeal: 'Cosku',
    Conviction: 'Inanc',
    Fervor: 'Atesli Cosku',
    Dominate: 'Hukumranlik',
    'Rapid Recovery': 'Hizli Toparlanma',
    Resilience: 'Dayaniklilik',
    'Sentinel Armor': 'Gozcu Zirhi',
    Accelerant: 'Hizlandirici',
    Napalm: 'Napalm',
    Blaze: 'Alevlenme',
    Intensity: 'Yogunluk',
    Pyromania: 'Piromani',
    'Lingering Chill': 'Kalici Usume',
    'Bone Chill': 'Kemik Usuten Soguk',
    'Frost Bite': 'Don Isirigi',
    'Dry Ice': 'Kuru Buz',
    'Ice Casket': 'Buz Tabutu',
    Chilblains: 'Soguk Yaralari',
    'Piercing Cold': 'Delici Soguk',
    Harmony: 'Uyum',
    Conserve: 'Tasarruf',
    'Cold Hearted': 'Soguk Kalpli',
    'Twisted Hex': 'Carpik Lanet',
    'Tenacious Hex': 'Inatci Lanet',
    Doom: 'Kiyamet',
    'Insidious Poison': 'Sinsi Zehir',
    'Wind Cloak': 'Ruzgar Pelerini',
    'Life Shield': 'Can Kalkani',
    'Cursed Sword': 'Lanetli Kilic',
    'Blood Bond': 'Kan Bagi',
    'Lingering Curse': 'Kalici Lanet',
    'Crippling Curse': 'Sakatlayan Lanet',
    'Cursed Armor': 'Lanetli Zirh',
    'Minion Master': 'Hizmetkar Ustasi',
    Daybreak: 'Safak',
    Fortify: 'Guclendir',
    Sanctify: 'Kutsalla',
    'Blinding Light': 'Kor Eden Isik',
    'Clutch Heal': 'Son Anda Sifa',
    'Basic Attack': 'Temel Saldiri',
    'Attack I': 'Saldiri I',
    'Attack II': 'Saldiri II',
    'Attack III': 'Saldiri III',
    'Attack IV': 'Saldiri IV',
    'Attack V': 'Saldiri V',
    'Attack VI': 'Saldiri VI',
    'Attack VII': 'Saldiri VII',
    'Attack VIII': 'Saldiri VIII',
    'Attack IX': 'Saldiri IX',
    'Attack X': 'Saldiri X',
    'Attack XI': 'Saldiri XI',
    'Attack XII': 'Saldiri XII',
    'Attack XIII': 'Saldiri XIII',
    'Attack XIV': 'Saldiri XIV',
    'Magic I': 'Buyu I',
    'Magic II': 'Buyu II',
    'Magic III': 'Buyu III',
    'Magic IV': 'Buyu IV',
    'Magic V': 'Buyu V',
    'Magic VI': 'Buyu VI',
    'Magic VII': 'Buyu VII',
    'Magic VIII': 'Buyu VIII',
    'Magic IX': 'Buyu IX',
    'Magic X': 'Buyu X',
    'Magic XI': 'Buyu XI',
    'Magic XII': 'Buyu XII',
    'Magic XIII': 'Buyu XIII',
    'Magic XIV': 'Buyu XIV',
    'Defense I': 'Savunma I',
    'Defense II': 'Savunma II',
    'Defense III': 'Savunma III',
    'Defense IV': 'Savunma IV',
    'Defense V': 'Savunma V',
    'Defense VI': 'Savunma VI',
    'Defense VII': 'Savunma VII',
    'Defense VIII': 'Savunma VIII',
    'Defense IX': 'Savunma IX',
    'Defense X': 'Savunma X',
    'Defense XI': 'Savunma XI',
    'Defense XII': 'Savunma XII',
    'Defense XIII': 'Savunma XIII',
    'Defense XIV': 'Savunma XIV',
    'Health I': 'Can I',
    'Health II': 'Can II',
    'Health III': 'Can III',
    'Health IV': 'Can IV',
    'Health V': 'Can V',
    'Health VI': 'Can VI',
    'Health VII': 'Can VII',
    'Health VIII': 'Can VIII',
    'Health IX': 'Can IX',
    'Health X': 'Can X',
    'Health XI': 'Can XI',
    'Health XII': 'Can XII',
    'Health XIII': 'Can XIII',
    'Health XIV': 'Can XIV',
    'Expertise I': 'Uzmanlik I',
    'Expertise II': 'Uzmanlik II',
    'Expertise III': 'Uzmanlik III',
    'Expertise IV': 'Uzmanlik IV',
    'Expertise V': 'Uzmanlik V',
    'Expertise VI': 'Uzmanlik VI',
    'Expertise VII': 'Uzmanlik VII',
    'Expertise VIII': 'Uzmanlik VIII',
    'Expertise IX': 'Uzmanlik IX',
    'Expertise X': 'Uzmanlik X',
    'Expertise XI': 'Uzmanlik XI',
    'Expertise XII': 'Uzmanlik XII',
    'Expertise XIII': 'Uzmanlik XIII',
    'Expertise XIV': 'Uzmanlik XIV',
    Recovery: 'Toparlanma',
    'Bleed Damage': 'Kanama Hasari',
    'Bleed Stacks': 'Kanama Yukleri',
    'Poison Damage': 'Zehir Hasari',
    'Poison vs Bleeding': 'Kanayan Hedeflere Zehir',
    'Duration (seconds)': 'Sure (saniye)',
    Effect: 'Etki',
    'Critical Chance': 'Kritik Sans',
    'Hemorrhage Damage': 'Kanama Kritik Hasari',
    'Elemental Damage': 'Element Hasari',
    'Heavy Blow Damage': 'Agir Darbe Hasari',
    'Bonus Damage': 'Bonus Hasar',
    'Defense Bonus': 'Savunma Bonusu',
    'Critical Chance Bonus': 'Kritik Sans Bonusu',
    'Healing (% Expertise)': 'Sifa (% Uzmanlik)',
    'Ignite Damage': 'Tutusturma Hasari',
    'Attack Speed Bonus': 'Saldiri Hizi Bonusu',
    'Cooldown (seconds)': 'Bekleme (saniye)',
    'Recovery Bonus': 'Toparlanma Bonusu',
    Hate: 'Nefret',
    'DoT Reduction': 'Zamanla Hasar Azaltma',
    'Attack (% Expertise)': 'Saldiri (% Uzmanlik)',
    'Defense (% Expertise)': 'Savunma (% Uzmanlik)',
    'HP (% Expertise)': 'Can (% Uzmanlik)',
    Tenacity: 'Metanet',
    'Debuff Reduction': 'Zayiflatma Azaltma',
    'Burn Damage': 'Yanma Hasari',
    'Burn Stacks': 'Yanma Yukleri',
    'Scorch Stacks': 'Kavurma Yukleri',
    'Chilblains Stacks': 'Soguk Yaralari Yukleri',
    'Damage (%Expertise)': 'Hasar (% Uzmanlik)',
    'Chilblains Damage': 'Soguk Yaralari Hasari',
    'Defense Reduction': 'Savunma Azaltma',
    'Drain Pause (seconds)': 'Tuketim Duraklamasi (saniye)',
    Penalty: 'Ceza',
    'Poison vs Bound': 'Bagli Hedeflere Zehir',
    'HP Regen (Expertise)': 'Can Yenilenmesi (Uzmanlik)',
    Transferred: 'Aktarilan',
    'Expertise Bonus': 'Uzmanlik Bonusu',
    'Miss Chance': 'Iskalama Sansi',
    'Healing Boost': 'Sifa Artisi',
    Attack: 'Saldiri',
    Magic: 'Buyu',
    Defense: 'Savunma',
    Health: 'Can',
    Expertise: 'Uzmanlik'
}));

const POWER_EFFECT_LABELS = new Map(Object.entries({
    'AoE': 'alan etkisi',
    'Armor Bane': 'Zirh Kirici',
    'Armor Break': 'Zirh Kirma',
    'Attack Boost': 'saldiri artisi',
    'Attack Damage': 'saldiri hasari',
    'Attack Debuff': 'saldiri zayiflatmasi',
    'Attack Speed Reduction': 'saldiri hizi azaltma',
    'Bind': 'Baglama',
    'Bind Damage': 'baglama hasari',
    'Bind Strength Damage': 'baglama gucu hasari',
    'Bleed': 'Kanama',
    'Blind': 'Kor Etme',
    'Burn': 'Yanma',
    'Cast Time': 'kullanim suresi',
    'Chaos Poison': 'Kaos Zehri',
    'Chilblains': 'Soguk Yaralari',
    'Cooldown': 'bekleme suresi',
    'Cripple': 'Sakatlama',
    'Crippled': 'Sakatlama',
    'Curse': 'Lanet',
    'Damage': 'hasar',
    'Damage Bonus': 'hasar bonusu',
    'Dash Armor': 'atilma zirhi',
    'Dash Damage': 'atilma hasari',
    'Defense': 'savunma',
    'Defense Boost': 'savunma artisi',
    'Defense Buff': 'savunma guclendirmesi',
    'Defense Debuff': 'savunma zayiflatmasi',
    'Daze': 'Afallatma',
    'Heal': 'iyilestirme',
    'Heightened Defense': 'guctenmis savunma',
    'Holy Fire Damage': 'kutsal ates hasari',
    'Ignite': 'Tutusturma',
    'Ignite Bonus': 'tutusturma bonusu',
    'Lance Damage': 'mizrak hasari',
    'Mana': 'mana',
    'Mana Cost': 'mana maliyeti',
    'Mana Requirement': 'mana gereksinimi',
    'Range': 'menzil',
    'Scorch': 'Kavurma',
    'Slowed and Immobilized Enemies': 'yavaslamis ve hareketsiz dusmanlar',
    'Stagger': 'Sarsma',
    'Stun': 'Sersemletme',
    'trail Damage': 'iz hasari',
    'Weaken': 'Zayiflatma'
}));

function lowerFirst(value) {
    const text = String(value ?? '');
    return text ? text.toLocaleLowerCase('en-US') : text;
}

function localizePowerEffectLabel(source) {
    const value = String(source ?? '').trim().replace(/\s+/g, ' ');
    if (!value) {
        return value;
    }

    const placeholderText = (value.match(/#\w+#/g) || []).join(' ');
    const valueWithoutPlaceholders = value.replace(/\s*#\w+#/g, '').trim();
    if (placeholderText && valueWithoutPlaceholders && valueWithoutPlaceholders !== value) {
        return cleanPowerText(`${localizePowerEffectLabel(valueWithoutPlaceholders)} ${placeholderText}`);
    }

    if (/\s+and\s+/i.test(valueWithoutPlaceholders)) {
        return valueWithoutPlaceholders
            .split(/\s+and\s+/i)
            .map((part) => lowerFirst(localizePowerEffectLabel(part)))
            .join(' ve ');
    }

    if (POWER_EFFECT_LABELS.has(value)) {
        return POWER_EFFECT_LABELS.get(value);
    }

    if (POWER_MOD_LABELS.has(value)) {
        return POWER_MOD_LABELS.get(value);
    }

    const noArticle = value.replace(/^(?:a|an|the)\s+/i, '');
    if (POWER_EFFECT_LABELS.has(noArticle)) {
        return POWER_EFFECT_LABELS.get(noArticle);
    }
    if (POWER_MOD_LABELS.has(noArticle)) {
        return POWER_MOD_LABELS.get(noArticle);
    }

    return localizePowerLabel(noArticle);
}

function manaChangeText(amount, label = 'maliyeti') {
    const numeric = Math.abs(Number(amount));
    const verb = Number(amount) < 0 ? 'azalir' : 'artar';
    return `Mana ${label} ${numeric} ${verb}.`;
}

function formatModifierAmount(amount) {
    const text = String(amount ?? '').trim().replace(/^\+/, '');
    return text.endsWith('%') ? `%${text.slice(0, -1)}` : text;
}

function localizeDamageSchool(source) {
    const key = String(source ?? '').trim().toLowerCase();
    const labels = new Map(Object.entries({
        air: 'hava',
        death: 'olum',
        earth: 'toprak',
        fire: 'ates',
        ice: 'buz',
        life: 'yasam',
        mythic: 'efsanevi'
    }));
    return labels.get(key) || lowerFirst(localizePowerEffectLabel(source));
}

function modifierNoun(property) {
    const key = String(property ?? '').trim().toLowerCase();
    if (['damage', 'melee damage', 'poison damage', 'base damage', 'dot'].includes(key)) {
        return 'hasari';
    }
    if (key === 'healing') {
        return 'iyilestirmesi';
    }
    if (key === 'effectiveness') {
        return 'etkisi';
    }
    if (key === 'duration') {
        return 'suresi';
    }
    if (key === 'durability') {
        return 'dayanikliligi';
    }
    if (key === 'health regen') {
        return 'can yenilenmesi';
    }
    if (key === 'life siphon') {
        return 'can emmesi';
    }
    if (key === 'attack leech') {
        return 'saldiri somurusu';
    }
    if (key === 'ghoul attack') {
        return 'gulyabani saldirisi';
    }
    if (key === 'defense' || key === 'defense boost') {
        return 'savunmasi';
    }
    return lowerFirst(localizePowerEffectLabel(property));
}

function hasUntranslatedPowerEnglish(value) {
    return /\b(?:that|your|you|them|their|with|when|while|under|through|against|around|from|into|secondary|Deliver|Calls|Create|Creates|Conjure|Envoke|Rain|Turns|Weaken|Scorching|Burns|Chills|Freezing|Poisoned|Bound|Dash|Requirement|Bonus|Cap|Ao E|Holy|Improved|Inflicts|Applies|Each|Per|sec|unique|debuffed|Debuffed|Regen|active|behalf|moment|trail|force field|temporary|depleted|activated|explodes|Lightning|Secondary)\b|mana bedel|artan hasar|verir hasar|icinde Ao/i.test(String(value ?? ''));
}

function localizePowerParagraph(source) {
    const value = String(source ?? '').trim();
    if (!value) {
        return value;
    }

    const normalized = value
        .replace(/\bAoE\b/g, 'AoE')
        .replace(/(%|#\w+#)and\s+(?=(?:Increased|Improved|Adds?|Grants?|Gain|Applies|Inflicts|Deals?|Staggers?|Stuns?))/gi, '$1 and ')
        .replace(/\s+/g, ' ')
        .trim();

    const direct = localizePowerSentence(normalized);
    if (!hasUntranslatedPowerEnglish(direct)) {
        return cleanPowerText(direct);
    }

    const parts = normalized
        .split(/\.\s+/)
        .flatMap((part) => part.split(/\s+and\s+(?=(?:Increased|Improved|Adds?|Grants?|Gain|Applies|Inflicts|Deals?|\+?\-?\d))/i))
        .flatMap((part) => part.split(/,\s+(?=(?:Increased|Improved|Adds?|Grants?|Gain|Applies|Inflicts|Deals?|\+?\-?\d))/i))
        .map((part) => part.trim().replace(/\.$/, ''))
        .filter(Boolean);

    if (parts.length > 1) {
        return cleanPowerText(parts.map((part) => localizePowerSentence(part)).filter(Boolean).join(' '));
    }

    return localizePowerSentence(parts[0] || normalized);
}

function localizePowerSentence(source) {
    let value = String(source ?? '')
        .replace(/\byouself\b/gi, 'yourself')
        .replace(/\bstrenghtens\b/gi, 'strengthens')
        .replace(/\bintial\b/gi, 'initial')
        .trim();

    if (!value || /^[-]+$/.test(value)) {
        return normalizeAscii(value);
    }

    if (/^Your party's attacks apply Scorched and gain bonus damage against Scorched targets\.?$/i.test(value)) {
        return 'Grubunun saldirilari Kavrulmus uygular ve Kavrulmus hedeflere karsi bonus hasar kazanir.';
    }

    const exact = new Map(Object.entries({
        'Deliver a multi-hit melee combo that damages nearby foes': 'Yakindaki dusmanlara hasar veren cok vuruslu yakin dovus kombosu yapar',
        'Deliver two bonecrushing blows that total #dmg# damage to every foe within reach of your swing.': 'Savurma menzilindeki tum dusmanlara toplam #dmg# hasar veren iki kemik kiran darbe indirir.',
        'Launch a quick 3 hit assault on a single opponent': 'Tek bir rakibe hizli, uclu saldiri yapar',
        'Launch a quick 3 hit assault on a single opponent and Ignite them': 'Tek bir rakibe hizli, uclu saldiri yapar ve hedefi tutusturur',
        'Launch a quick 3 hit assault on a single opponent, Igniting them and reducing their Defense': 'Tek bir rakibe hizli, uclu saldiri yapar; hedefi tutusturur ve savunmasini azaltir',
        'Deliver two quick jabs and a vicious thrust of your sword that total #dmg# damage to your target.': 'Hedefe toplam #dmg# hasar veren iki hizli saplama ve acimasiz bir kilic hamlesi yapar.',
        'Cleave an arc of destruction that deals #dmg# damage to every foe in its wake.': 'Onundeki tum dusmanlara #dmg# hasar veren yikici bir yay cizer.',
        'Unleash a single, heavy melee attack that damages nearby foes': 'Yakindaki dusmanlara hasar veren tek ve agir bir yakin dovus saldirisi yapar',
        'Unleash a single, heavy melee attack that damages and Cripples nearby foes': 'Yakindaki dusmanlara hasar veren ve onlari sakatlayan tek ve agir bir yakin dovus saldirisi yapar',
        'Channel holy energy that restores the health of the most wounded player': 'En yarali oyuncunun canini yenileyen kutsal enerji kanalize eder',
        'Channel energy that restores your life or that of a more wounded ally': 'Senin veya daha yarali bir muttefigin canini yenileyen enerji kanalize eder',
        'Channel holy energy that restores the health and strengthens the Defense of the most wounded player': 'En yarali oyuncunun canini yeniler ve savunmasini guclendiren kutsal enerji kanalize eder',
        'Deal damage to foes in the impact area, Demoralizing and Taunting them': 'Etki alanindaki dusmanlara hasar verir, morallerini bozar ve onlari kiskirtir',
        'Deal damage to foes in the impact area, Staggering, Demoralizing and Taunting them': 'Etki alanindaki dusmanlara hasar verir; onlari sarsar, morallerini bozar ve kiskirtir',
        'Stun and damage your foe with a quick shield bash': 'Hizli bir kalkan darbesiyle dusmani sersemletir ve hasar verir',
        'Stun, Ignite and damage your foe with a quick shield bash': 'Hizli bir kalkan darbesiyle dusmani sersemletir, tutusturur ve hasar verir',
        'Channel holy energy to heal yourself and your allies overtime': 'Seni ve muttefiklerini zamanla iyilestiren kutsal enerji kanalize eder',
        'Channel holy energy to heal yourself and your allies overtime. Grants increased Defense for the duration': 'Seni ve muttefiklerini zamanla iyilestiren kutsal enerji kanalize eder. Sure boyunca savunma artisi verir',
        'Summon holy armor, damaging and Taunting nearby foes in the process': 'Kutsal zirh cagirir; bu sirada yakindaki dusmanlara hasar verir ve onlari kiskirtir',
        'Grant your allies a small healing surge and Weaken your enemies in an AoE': 'Muttefiklerine kucuk bir iyilestirme dalgasi verir ve alandaki dusmanlari zayiflatir',
        'Enchant an ally with an aura that heals nearby friends and damages foes over time.': 'Bir muttefigi, yakindaki dostlari iyilestiren ve dusmanlara zamanla hasar veren bir aurayla guclendirir.',
        'Your basic attacks explode with energy, healing allies and harming foes': 'Temel saldirilar enerjiyle patlar; muttefikleri iyilestirir ve dusmanlara zarar verir',
        'Your basic attacks channel divine energy, healing allies and harming foes': 'Temel saldirilar ilahi enerji kanalize eder; muttefikleri iyilestirir ve dusmanlara zarar verir',
        'Summon Mighty flaming fists to pummel your foes. Deals extra damage to Ignited targets.': 'Dusmanlarini ezen guclu alevli yumruklar cagirir. Tutusmus hedeflere ek hasar verir.',
        'Summon mighty flaming fists to pummel your foes. Deals extra damage to Ignited targets.': 'Dusmanlarini ezen guclu alevli yumruklar cagirir. Tutusmus hedeflere ek hasar verir.',
        'Smash and Taunt your foes with a wave attack.': 'Dalga saldirisiyla dusmanlari ezer ve kiskirtir.',
        'Return some damage back to your attackers. Gain increased Hate for the duration.': 'Saldirganlara aldigin hasarin bir kismini geri yansitir. Sure boyunca nefret kazanimin artar.',
        "Your party's attacks apply Scorched and gain bonus damage against Scorched targets.": 'Grubunun saldirilari Kavrulmus uygular ve Kavrulmus hedeflere karsi bonus hasar kazanir.',
        'Shroud yourself with shadow energy. Your next attack will deal bonus damage and end the effect.': 'Kendini golge enerjisiyle sarar. Sonraki saldirin bonus hasar verir ve etkiyi bitirir.',
        'Leaps to target dealing damage at take off and impact. Deals extra damage to Ignited targets.': 'Hedefe sicrar; kalkista ve carpmada hasar verir. Tutusmus hedeflere ek hasar verir.',
        'Leaps to target dealing damage at take off and impact. Deals extra damage to Ignited targets': 'Hedefe sicrar; kalkista ve carpmada hasar verir. Tutusmus hedeflere ek hasar verir.',
        'Enchant your basic attacks with powerful ice effects.': 'Temel saldirilarini guclu buz etkileriyle buyuler.',
        'Slash nearby enemies and remove up to 3 stacks of Bleed per target. Removed Bleed deals extra damage to that target.': 'Yakindaki dusmanlari keser ve hedef basina en fazla 3 Kanama yukunu kaldirir. Kaldirilan Kanama hedefe ek hasar verir.',
        'Unleash a multi-hit melee combo that applies Bleed with every blow. Deals extra damage to poisoned targets': 'Her darbede Kanama uygulayan cok vuruslu yakin dovus kombosu yapar. Zehirlenmis hedeflere ek hasar verir.',
        'Curse your foe from a distance and deal additional damage for conditions on it (positive and negative).': 'Dusmani uzaktan lanetler ve uzerindeki olumlu ya da olumsuz kosullara gore ek hasar verir.',
        'Strike your foe from a distance and deal additional damage for conditions on it (positive and negative).': 'Dusmana uzaktan vurur ve uzerindeki olumlu ya da olumsuz kosullara gore ek hasar verir.',
        'Enchant your staff to fire meteors for the next #dur# seconds. Meteors deal heavy damage on impact to all nearby foes.': 'Asani #dur# saniye boyunca meteor firlatacak sekilde buyuler. Meteorlar carptiginda yakindaki tum dusmanlara agir hasar verir.',
        'Summon a Spirit of Flame that shoots at your targets. Gain increased Damage but reduced Defense for the duration.': 'Hedeflerine ates eden bir Alev Ruhu cagirir. Sure boyunca hasarin artar ama savunman azalir.',
        'Stance: For duration, radiates Enfeeble. Attacks deal extra damage based on how hurt caster is. Caster is immune to heal while active.': 'Durus: Sure boyunca Gucsuzlestirme yayar. Saldirilar, kullananin yaralilik durumuna gore ek hasar verir. Aktifken iyilestirmeye bagisiktir.',
        'Heals allies in an area and Blinds foes': 'Alandaki muttefikleri iyilestirir ve dusmanlari kor eder',
        'Strike a foe with an explosive lance, bathing enemies in the area with Holy Fire': 'Patlayici bir mizrakla dusmana vurur ve alandaki dusmanlari kutsal atese bogar',
        'Strike a foe with an explosive lance, Staggering and bathing enemies in the area with Holy Fire': 'Patlayici bir mizrakla dusmana vurur; hedefi sarsar ve alandaki dusmanlari kutsal atese bogar',
        'Stun a foe with an explosive lance, Staggering and bathing enemies in the area with Holy Fire': 'Patlayici bir mizrakla dusmani sersemletir; hedefi sarsar ve alandaki dusmanlari kutsal atese bogar',
        'Enchant your staff to fire meteors that deal damage in an area': 'Asani, alana hasar veren meteorlar firlatacak sekilde guclendirir',
        'Enchant your staff to fire meteors that deal damage and Scorch in an area': 'Asani, alana hasar veren ve kavuran meteorlar firlatacak sekilde guclendirir',
        'Call down waves of ice comets, pummeling and Chilling foes in the area': 'Buz kuyruklu yildiz dalgalari indirir; alandaki dusmanlari ezer ve usutur',
        'Gain increased Defense. Adds icy effects to your basic ranged and melee attacks.': 'Savunman artar. Temel menzilli ve yakin dovus saldirilarina buz etkileri ekler.',
        'Deal damage to single target and heals based on Expertise': 'Tek hedefe hasar verir ve uzmanliga gore iyilestirir',
        'Deals damage and Cripples enemies in AoE': 'Alan etkisindeki dusmanlara hasar verir ve onlari sakatlar',
        'Deals damage, Cripples and Blinds enemies in AoE': 'Alan etkisindeki dusmanlara hasar verir, onlari sakatlar ve kor eder',
        'Shake your foes to their core, leaving them vulnerable to subsequent attacks.': 'Dusmanlari sarsar ve sonraki saldirilara karsi savunmasiz birakir.',
        'Shake your foes to their core, Staggering them and leaving them vulnerable to subsequent attacks.': 'Dusmanlari sarsar, dengelerini bozar ve sonraki saldirilara karsi savunmasiz birakir.',
        'Target takes damage and erupts for additional AoE damage when it attacks.': 'Hedef hasar alir ve saldirdiginda patlayarak alana ek hasar verir.',
        'Heal and Cleanse your party, making them temporarily immune to negative conditions': 'Grubunu iyilestirir, arindirir ve kisa sureligine olumsuz kosullara bagisik hale getirir',
        'For 5 seconds your basic melee attacks deal AoE damage and Ignite targets.': '5 saniye boyunca temel yakin dovus saldirilarin alana hasar verir ve hedefleri tutusturur.',
        'Lob a flaming axe that explodes when it hits the ground, damaging and Igniting nearby foes': 'Yere carptiginda patlayan alevli bir balta firlatir; yakindaki dusmanlara hasar verir ve onlari tutusturur',
        'Turns a foe into a Lightning Bomb causing them to explode when killed. Spreads a similar effect to damaged enemies.': 'Bir dusmani Simsek Bombasina cevirir; hedef oldugunde patlar ve hasar alan dusmanlara benzer bir etki yayar.',
        'Turns a foe into a Lightning Bomb causing them to explode when killed. Bomb effect spreads to one affected target.': 'Bir dusmani Simsek Bombasina cevirir; hedef oldugunde patlar ve bomba etkisi etkilenen bir hedefe daha yayilir.',
        'Turns a foe into a Lightning Bomb causing them to explode when killed. Bomb effect can spread twice': 'Bir dusmani Simsek Bombasina cevirir; hedef oldugunde patlar ve bomba etkisi iki kez yayilabilir',
        'Turns a foe into a Lightning Bomb causing them to explode when killed. Bomb effect can spread three times': 'Bir dusmani Simsek Bombasina cevirir; hedef oldugunde patlar ve bomba etkisi uc kez yayilabilir',
        'Sear nearby foes, Igniting them and reducing their Defense.': 'Yakindaki dusmanlari yakar, tutusturur ve savunmalarini azaltir.',
        'Cripple and Weaken your target. Gain increased Defense during the swing.': 'Hedefi sakatlar ve zayiflatir. Savurma sirasinda savunman artar.',
        'Weaken your target. Gain increased Defense during the swing.': 'Hedefi zayiflatir. Savurma sirasinda savunman artar.',
        'Weaken and cripple your target. Gain increased Defense during the swing.': 'Hedefi zayiflatir ve sakatlar. Savurma sirasinda savunman artar.',
        'Weaken, Cripple and Daze your target. Gain increased Defense during the swing.': 'Hedefi zayiflatir, sakatlar ve afallatir. Savurma sirasinda savunman artar.',
        'Weaken, Cripple and Stun your target. Gain increased Defense during the swing.': 'Hedefi zayiflatir, sakatlar ve sersemletir. Savurma sirasinda savunman artar.',
        'Gain a force field with temporary HP. Explodes when depleted or activated.': 'Gecici can veren bir guc alani kazanir. Tukenince veya etkinlestirilince patlar.',
        'Gain a force field with temporary HP. Explodes and Staggers when depleted or activated.': 'Gecici can veren bir guc alani kazanir. Tukenince veya etkinlestirilince patlar ve dusmanlari sarsar.',
        'Charge through and Stagger enemies. Gain increased Defense during the charge.': 'Dusmanlarin arasindan hucum eder ve onlari sarsar. Hucum sirasinda savunman artar.',
        'Charge through to Stagger and Cripple enemies. Gain increased Defense during the charge.': 'Dusmanlarin arasindan hucum ederek onlari sarsar ve sakatlar. Hucum sirasinda savunman artar.',
        'Taunt foes while Slowing them and reducing their damage': 'Dusmanlari yavaslatip hasarlarini azaltirken onlari kiskirtir',
        'Blast a cone of fire that damages each foe caught in the flames.': 'Alevlerin icinde kalan her dusmana hasar veren koni seklinde bir ates patlamasi yapar.',
        'Blast a cone of fire that Burns and damages each foe caught in the flames.': 'Alevlerin icinde kalan her dusmani yakar ve hasar veren koni seklinde bir ates patlamasi yapar.',
        'Dash through your foes, damaging and Freezing them': 'Dusmanlarin arasindan atilir, onlara hasar verir ve onlari dondurur',
        'Dash and Freeze foes. Applies Chilblains to Ice De-buffed targets': 'Dusmanlarin arasindan atilir ve onlari dondurur. Buz zayiflatmasi altindaki hedeflere Soguk Yaralari uygular',
        'Summon vines under your opponents. Damaging them and hindering them for a moment': 'Rakiplerinin altindan sarmasiklar cagirir; onlara hasar verir ve kisa sureligine engeller',
        'Summon vines under your opponents. Damaging, Weakening and hindering them for a moment': 'Rakiplerinin altindan sarmasiklar cagirir; onlara hasar verir, zayiflatir ve kisa sureligine engeller',
        'Summon vines under your opponents. Damaging, Weakening and Crippling them': 'Rakiplerinin altindan sarmasiklar cagirir; onlara hasar verir, zayiflatir ve sakatlar',
        'Summon a wave of fire that damages each foe in its path.': 'Yolundaki her dusmana hasar veren bir ates dalgasi cagirir.',
        'Summon a wave of fire that damages and Burns each foe in its path.': 'Yolundaki her dusmana hasar veren ve onlari yakan bir ates dalgasi cagirir.',
        'Summon a wave of fire that damages, Burns, Scorch each foe in its path.': 'Yolundaki her dusmana hasar veren, yakan ve kavuran bir ates dalgasi cagirir.',
        'Calls down a ranged AoE comet that Chills enemies.': 'Menzilli bir alan kuyruklu yildizi indirir ve dusmanlari usutur.',
        'Calls down a ranged AoE comet that damages enemies.': 'Menzilli bir alan kuyruklu yildizi indirir ve dusmanlara hasar verir.',
        'Calls down a ranged AoE comet that damages enemies. Applies Chilblains to Ice De-buffed targets': 'Menzilli bir alan kuyruklu yildizi indirir ve dusmanlara hasar verir. Buz zayiflatmasi altindaki hedeflere Soguk Yaralari uygular',
        'Calls down a ranged AoE comet that damages and Staggers enemies. Applies Chilblains to Ice De-buffed targets': 'Menzilli bir alan kuyruklu yildizi indirir; dusmanlara hasar verir ve onlari sarsar. Buz zayiflatmasi altindaki hedeflere Soguk Yaralari uygular',
        'Create a decoy that draws enemy attention and explodes. Gain damage immunity during the dash.': 'Dusman dikkatini ceken ve patlayan bir sahte hedef olusturur. Atilma sirasinda hasara bagisik olursun.',
        'Dash through your enemies, Scorching them and leaving a trail of fire.': 'Dusmanlarin arasindan atilir, onlari kavurur ve ardinda ates izi birakir.',
        'Dash through your enemies, Scorching them and leaving a trail of fire that Burns': 'Dusmanlarin arasindan atilir, onlari kavurur ve ardinda yakan bir ates izi birakir',
        'Rain Scorching meteors on your foes, Staggering them': 'Dusmanlarin uzerine kavuran meteorlar yagdirir ve onlari sarsar',
        "Your party's attacks apply Scorched and gain bonus damage against Scorched targets.": 'Grubunun saldirilari Kavrulmus uygular ve Kavrulmus hedeflere karsi bonus hasar kazanir.',
        'Conjure a giant molten fist beneath your foes that Scorches and Burns them, then explodes for more damage.': 'Dusmanlarin altinda dev bir erimis yumruk olusturur; onlari kavurup yakar, sonra daha fazla hasar icin patlar.',
        'Ranged attack that applies Curse, Armor Bane, and Weaken': 'Lanet, Zirh Kirici ve Zayiflatma uygulayan menzilli saldiri',
        'Ranged attack that applies Curse, Armor Bane, Weaken, and Poison': 'Lanet, Zirh Kirici, Zayiflatma ve Zehir uygulayan menzilli saldiri',
        'Weaken, Cripple and steal health from a foe': 'Dusmani zayiflatir, sakatlar ve canini emer',
        'Weaken, Cripple and steal health from a foe, healing yourself and regenerating your minions': 'Dusmani zayiflatir, sakatlar ve canini emer; seni iyilestirir ve hizmetkarlarini yeniler',
        'Envoke a vengeful spirit that blasts enemies around it. Deals extra damage for unique conditions on each target.': 'Etrafindaki dusmanlari patlatan intikamci bir ruh cagirir. Her hedefteki farkli kosullar icin ek hasar verir.',
        'You and each of your Undead minions place a powerful Poison on the next enemy they attack.': 'Sen ve her Olumsuz hizmetkarin, saldirdiginiz sonraki dusmana guclu bir Zehir uygularsiniz.',
        'Deliver a massive leaping slam that deals damage to every nearby foe.': 'Yakindaki her dusmana hasar veren guclu bir sicrayis darbesi indirir.',
        'A single target melee combo that deals extra damage to Ignited foes.': 'Tutusan dusmanlara ek hasar veren tek hedefli yakin dovus kombosu yapar.',
        'Calls down lightning to harm enemies and boosts your movement speed': 'Dusmanlara zarar veren simsek indirir ve hareket hizini artirir',
        'Lightning strike that harms enemies and boosts your movement speed': 'Dusmanlara zarar veren ve hareket hizini artiran simsek darbesi yapar',
        'Lightning strike that harms and Blinds enemies, while boosting your movement speed': 'Dusmanlara zarar veren, onlari kor eden ve hareket hizini artiran simsek darbesi yapar',
        'Lightning strike that harms and Blinds enemies, while boosting your movement speed. Increased damaged vs Ignited Foes': 'Dusmanlara zarar veren, onlari kor eden ve hareket hizini artiran simsek darbesi yapar. Tutusan dusmanlara karsi hasari artar.',
        'Gain increased Damage and Health regen at the cost of reduced Defense': 'Savunma azalirken hasar ve can yenilenmesi artar',
        'Gain increased Damage and Health regen': 'Hasar ve can yenilenmesi artar',
        'Emit Shockwaves that damage and Blind nearby enemies. Gain increased Hate for the duration.': 'Yakindaki dusmanlara hasar veren ve onlari kor eden sok dalgalari yayar. Sure boyunca nefret kazanimin artar.',
        'Emit Shockwaves that damage, Blind and Stagger nearby enemies. Gain increased Hate for the duration.': 'Yakindaki dusmanlara hasar veren, onlari kor eden ve sarsan sok dalgalari yayar. Sure boyunca nefret kazanimin artar.',
        'Tranform into a powerful Battle Avatar.': 'Guclu bir savas avatarina donusur.',
        'Call a wave of frost that damages and Roots all foes in its path': 'Yolundaki tum dusmanlara hasar veren ve onlari kokleyen bir buz dalgasi cagirir',
        'Call a wave of frost that damages, Chills and Roots all foes in its path': 'Yolundaki tum dusmanlara hasar veren, onlari usuten ve kokleyen bir buz dalgasi cagirir',
        'Call a wave of frost that Chills and Roots all foes in its path. Applies Chilblains to Ice De-buffed targets': 'Yolundaki tum dusmanlari usuten ve kokleyen bir buz dalgasi cagirir. Buz zayiflatmasi altindaki hedeflere Soguk Yaralari uygular',
        'Summon a rolling gas cloud that damages and Poisons all foes in its path.': 'Yolundaki tum dusmanlara hasar veren ve zehir uygulayan yuvarlanan bir gaz bulutu cagirir.',
        'Summon a rolling gas cloud that damages, Weakens and Poisons all foes in its path.': 'Yolundaki tum dusmanlara hasar veren, onlari zayiflatan ve zehirleyen yuvarlanan bir gaz bulutu cagirir.',
        'Creates a Chilling ward that explodes and Freezes enemies.': 'Patlayip dusmanlari donduran usutucu bir muhafaza olusturur.',
        'Creates a Chilling ward that explodes, Weakening and Freezing enemies.': 'Patlayip dusmanlari zayiflatan ve donduran usutucu bir muhafaza olusturur.',
        'Creates a Chilling ward that explodes, Weakening and Freezing enemies and reducing their attack speed.': 'Patlayip dusmanlari zayiflatan, donduran ve saldiri hizlarini azaltan usutucu bir muhafaza olusturur.',
        'Emit a cone of Chilling frost. Ice-debuffed targets gain Chilblains': 'Usutucu bir buz konisi yayar. Buz zayiflatmasi altindaki hedefler Soguk Yaralari kazanir',
        'Release a wave of frost that Roots enemies in its path.': 'Yolundaki dusmanlari kokleyen bir buz dalgasi salar.',
        'Release a wave of frost that Roots and Weakens enemies in its path.': 'Yolundaki dusmanlari kokleyen ve zayiflatan bir buz dalgasi salar.',
        'Conjure a massive icicle that deals Chilblains to ice-debuffed targets.': 'Buz zayiflatmasi altindaki hedeflere Soguk Yaralari uygulayan dev bir buz sarkiti olusturur.',
        'Summons an immobile Tundra Wyrm that attacks nearby enemies. Deals extra damage to enemies with ice debuffs.': 'Yakindaki dusmanlara saldiran hareketsiz bir Tundra Ejderi cagirir. Buz zayiflatmasi olan dusmanlara ek hasar verir.',
        'Summons an immobile Tundra Wyrm that attacks nearby enemies. Deals extra damage to Ice-debuffed targets': 'Yakindaki dusmanlara saldiran hareketsiz bir Tundra Ejderi cagirir. Buz zayiflatmasi altindaki hedeflere ek hasar verir',
        'Conjure an animated ice blade that attacks on your behalf.': 'Senin yerine saldiran canli bir buz bicagi olusturur.',
        'Conjure an animated ice blade that attacks and Chills on your behalf.': 'Senin yerine saldiran ve dusmanlari usuten canli bir buz bicagi olusturur.',
        'Create a pillar of fire that Scorches targets.': 'Hedefleri kavuran bir ates sutunu olusturur.',
        'Create a pillar of fire that Scorches and Burns targets.': 'Hedefleri kavuran ve yakan bir ates sutunu olusturur.',
        'Dash through your enemies, leaving a trail of Scorching fire.': 'Dusmanlarin arasindan atilir ve ardinda kavuran bir ates izi birakir.',
        'Rain Scorching meteors on your foes.': 'Dusmanlarinin uzerine kavuran meteorlar yagdirir.',
        'Summon a Spirit of Flame that shoots at your targets. Gain increased damage but reduced Defense for the duration.': 'Hedeflerine ates eden bir Alev Ruhu cagirir. Sure boyunca hasarin artar ama savunman azalir.',
        'Flameseer basic ranged. Every third shot applies Burn and has a chance of dealing AoE damage.': 'Alevgorur temel menzilli saldirisi. Her ucuncu atis Yanma uygular ve alan hasari verme sansi tasir.',
        'Stance that overrides basic attacks with a powerful flamethrower.': 'Temel saldirilari guclu bir alev puskurtucuyle degistiren durus.',
        'Lob a projectile that Burns enemies.': 'Dusmanlari yakan bir mermi firlatir.',
        'Lob a projectile that Scorches and Burns enemies.': 'Dusmanlari kavuran ve yakan bir mermi firlatir.',
        'Emit a bright burst of fire that Scorches, Burns, and Blinds nearby enemies.': 'Yakindaki dusmanlari kavuran, yakan ve kor eden parlak bir ates patlamasi yayar.',
        'Emit a bright burst of fire that Staggers, Scorches, Burns, and Blinds nearby enemies.': 'Yakindaki dusmanlari sarsan, kavuran, yakan ve kor eden parlak bir ates patlamasi yayar.',
        'Targets within the radius take damage and become Infested. If a Target dies under while this condition, it spawns a Bone Worm.': 'Yaricap icindeki hedefler hasar alir ve Istila etkisine girer. Bu kosul altindayken olen hedef bir Kemik Solucani dogurur.',
        'Creates a ward. Enemies within are Cursed and have reduced Attack.': 'Bir muhafaza olusturur. Icindeki dusmanlar lanetlenir ve saldirilari azalir.',
        'Creates a ward. Enemies within are Cursed and have reduced Attack and Defense.': 'Bir muhafaza olusturur. Icindeki dusmanlar lanetlenir; saldirilari ve savunmalari azalir.',
        'Ranged attack that applies Curse and Armor Bane': 'Lanet ve Zirh Kirici uygulayan menzilli saldiri',
        'Deliver a pair of blows that stun your target for 2 seconds and deal a total of #dmg# damage.': 'Hedefi 2 saniye sersemleten ve toplam #dmg# hasar veren iki darbe indirir.',
        'Deliver a pair Stunning of blows': 'Hedefi sersemleten iki darbe indirir',
        'Deliver a pair of blows that Stun and apply Armor Bane': 'Hedefi sersemleten ve Zirh Kirici uygulayan iki darbe indirir',
        'Deliver a pair of blows that Stun, Cripple and apply Armor Bane': 'Hedefi sersemleten, sakatlayan ve Zirh Kirici uygulayan iki darbe indirir',
        'Deal two venomous strikes that apply a deadly poison to your foe': 'Dusmana olumcul zehir uygulayan iki zehirli darbe vurur',
        'Deal two venomous strikes that Blind and apply a deadly poison to your foe': 'Dusmani kor eden ve olumcul zehir uygulayan iki zehirli darbe vurur',
        'Deal two venomous strikes that Blind, Cripple and apply a deadly poison to your foe': 'Dusmani kor eden, sakatlayan ve olumcul zehir uygulayan iki zehirli darbe vurur',
        'Deal two venomous strikes that Blind, Cripple, Weaken and apply a deadly poison to your foe': 'Dusmani kor eden, sakatlayan, zayiflatan ve olumcul zehir uygulayan iki zehirli darbe vurur',
        'Deliver three slashing blows to your foe': 'Dusmana uc kesici darbe indirir',
        'Deliver three slashing blows to your foe to deal extra damage to Poisoned or Bleeding targets': 'Zehirlenmis veya kanayan hedeflere ek hasar veren uc kesici darbe indirir',
        'Deliver three blows to your foe to deal extra damage to Poisoned or Bleeding targets. Gain Heightened Defense for 1 sec.': 'Zehirlenmis veya kanayan hedeflere ek hasar veren uc darbe indirir. 1 saniyeligine guclenmis savunma kazanir.',
        'Deliver a strike that Enfeebles your target': 'Hedefi gucsuzlestiren bir darbe indirir',
        'Deliver a strike that Enfeebles and Blinds your target': 'Hedefi gucsuzlestiren ve kor eden bir darbe indirir',
        'Deliver a strike that Enfeebles and Blinds your target. Deals extra damage to Enfeebled targets': 'Hedefi gucsuzlestiren ve kor eden bir darbe indirir. Gucsuzlesmis hedeflere ek hasar verir.',
        'Deliver a strike that Enfeebles, Dazes and Blinds your target. Deals extra damage to Enfeebled targets': 'Hedefi gucsuzlestiren, afallatan ve kor eden bir darbe indirir. Gucsuzlesmis hedeflere ek hasar verir.',
        "Raise entangling vines that root all foes within the vine's reach for #dur# seconds and deals #dmg# damage.": 'Sarmasigin erisimindeki tum dusmanlari #dur# saniye kokleyen ve #dmg# hasar veren dolasik sarmasiklar yukseltir.',
        "Raise entangling vines that root all foes within the vine's reach": 'Sarmasigin erisimindeki tum dusmanlari kokleyen dolasik sarmasiklar yukseltir',
        "Raise Strangling vines that root all foes within the vine's reach": 'Sarmasigin erisimindeki tum dusmanlari kokleyen bogucu sarmasiklar yukseltir',
        'Attack with four whirling slashes to nearby targets.': 'Yakindaki hedeflere dort donen kesik savurur.',
        'Attack with four whirling slashes, Crippling nearby targets.': 'Yakindaki hedefleri sakatlayan dort donen kesik savurur.',
        'Attack with four whirling slashes, Crippling and applying Bleed to nearby targets.': 'Yakindaki hedefleri sakatlayan ve Kanama uygulayan dort donen kesik savurur.',
        'Deliver a single brutal blow to your foe.': 'Dusmana tek ve sert bir darbe indirir.',
        'Deliver a single brutal, Stunning blow to your foe.': 'Dusmana tek, sert ve sersemletici bir darbe indirir.',
        'Stab your target and reduce their Defense against further attacks': 'Hedefi bicaklar ve sonraki saldirilara karsi savunmasini azaltir',
        'Place a distracting booby trap filled with bombs that Poisons enemies': 'Dusmanlari zehirleyen bombalarla dolu dikkat dagitici bir tuzak kurar',
        'Place a distracting booby trap filled with bombs that Poisons and Cripples enemies': 'Dusmanlari zehirleyen ve sakatlayan bombalarla dolu dikkat dagitici bir tuzak kurar',
        'Place a distracting booby trap filled with bombs that Poisons, Cripples and applies Bleed to enemies': 'Dusmanlari zehirleyen, sakatlayan ve Kanama uygulayan bombalarla dolu dikkat dagitici bir tuzak kurar',
        'Place a distracting booby trap filled with bombs that Poisons, Cripples, Blinds and applies Bleed to enemies': 'Dusmanlari zehirleyen, sakatlayan, kor eden ve Kanama uygulayan bombalarla dolu dikkat dagitici bir tuzak kurar',
        'Place a distracting booby trap filled with bombs that Poisons, Cripples, Blinds, and applies Bleed to enemies': 'Dusmanlari zehirleyen, sakatlayan, kor eden ve Kanama uygulayan bombalarla dolu dikkat dagitici bir tuzak kurar',
        'Place a distracting booby trap filled with bombs that Poisons, Cripples, Blinds, Weakens and applies Bleed to enemies': 'Dusmanlari zehirleyen, sakatlayan, kor eden, zayiflatan ve Kanama uygulayan bombalarla dolu dikkat dagitici bir tuzak kurar',
        'Place a distracting booby trap filled with bombs that Poisons, Cripples, Blinds, Weakens and applies Bleed and Armor Bane to enemies': 'Dusmanlari zehirleyen, sakatlayan, kor eden, zayiflatan, Kanama ve Zirh Kirici uygulayan bombalarla dolu dikkat dagitici bir tuzak kurar',
        'Throw three Poison Daggers.': 'Uc zehir hanceri firlatir.',
        'Throw four Poison Daggers.': 'Dort zehir hanceri firlatir.',
        'Throw four Poison Daggers that reduce target Defense.': 'Hedefin savunmasini azaltan dort zehir hanceri firlatir.',
        'Unleash a multi-hit melee combo that applies Bleed with every blow.': 'Her darbede Kanama uygulayan cok vuruslu yakin dovus kombosu yapar.',
        'Strike a foe and apply Weaken, Cripple and Armor Bane.': 'Dusmana vurur; Zayiflatma, Sakatlama ve Zirh Kirici uygular.',
        'Slash nearby enemies and remove up to 5 stacks of Bleed per target. Removed Bleed deals extra damage to that target.': 'Yakindaki dusmanlari keser ve hedef basina en fazla 5 Kanama yukunu kaldirir. Kaldirilan Kanama hedefe ek hasar verir.',
        'Launch multi-hit attack that applies Weaken and Bleed.': 'Zayiflatma ve Kanama uygulayan cok vuruslu saldiri baslatir.',
        'Applies Poison, Armor Bane, and 3 stacks of Bleed. Deals bonus damage to target based on missing health.': 'Zehir, Zirh Kirici ve 3 Kanama yuku uygular. Hedefin eksik canina gore bonus hasar verir.',
        'Dash and deal a powerful AoE Intimidate with 5 stacks of bleed. Gain increased Defense during the dash.': 'Atilir ve 5 Kanama yuklu guclu bir alan korkutmasi yapar. Atilma sirasinda savunman artar.',
        'Dash to enemies and deal a powerful AoE Attack Debuff with Bleed. Gain increased Defense during the dash.': 'Dusmanlara atilir ve Kanama iceren guclu bir alan saldiri zayiflatmasi yapar. Atilma sirasinda savunman artar.',
        'Dash to a target and unleash a multi-hit combo that applies Bleed with every blow.': 'Hedefe atilir ve her darbede Kanama uygulayan cok vuruslu bir kombo yapar.',
        'Dash forward, damaging and applying Bleed to every enemy in your path.': 'Ileri atilir; yolundaki her dusmana hasar verir ve Kanama uygular.',
        'Dash forward, damaging, Crippling and applying Bleed to every enemy in your path.': 'Ileri atilir; yolundaki her dusmana hasar verir, Sakatlama ve Kanama uygular.',
        'Transform into a Death Avatar. Gain increased Attack damage for the duration.': 'Olum Avatarina donusur. Sure boyunca saldiri hasarin artar.',
        'Return to your normal state.': 'Normal haline doner.',
        'Deal damage to single target and heals based on Expertise': 'Tek hedefe hasar verir ve uzmanliga gore iyilestirir',
        'Strike your foe and heal your wounds': 'Dusmana vurur ve yaralarini iyilestirir',
        'Melee Attack. Damages and Binds a single target.': 'Tek hedefe hasar veren ve Baglama uygulayan yakin dovus saldirisi.',
        'Damages and Binds a single target.': 'Tek hedefe hasar verir ve Baglama uygular.',
        'Damages, Cripples and Binds a single target.': 'Tek hedefe hasar verir; Sakatlama ve Baglama uygular.',
        'Damages, Cripples, Poisons and Binds a single target.': 'Tek hedefe hasar verir; Sakatlama, Zehir ve Baglama uygular.',
        'Release Chaotic energy, Binding and reducing the Attack of nearby foes': 'Kaotik enerji salar; yakindaki dusmanlari baglar ve saldirilarini azaltir',
        'Release Chaotic energy, Binding and reducing the Attack of nearby foes. Grants an Expertise buff': 'Kaotik enerji salar; yakindaki dusmanlari baglar ve saldirilarini azaltir. Uzmanlik guclendirmesi verir.',
        'Release Chaotic energy, Binding, Poisoning and reducing the Attack of nearby foes. Grants an Expertise buff': 'Kaotik enerji salar; yakindaki dusmanlari baglar, zehirler ve saldirilarini azaltir. Uzmanlik guclendirmesi verir.',
        'Strike your opponent with a powerful blow, dealing increased damage to Bound targets': 'Rakibe guclu bir darbe indirir; Bagli hedeflere daha fazla hasar verir',
        'Vampiric AoE attack.': 'Vampirik alan saldirisi.',
        'Vampiric AoE attack that deals increased damage to Bound targets': 'Bagli hedeflere daha fazla hasar veren vampirik alan saldirisi',
        'Dashing attack that applies Poison to all targets in your path.': 'Yolundaki tum hedeflere Zehir uygulayan atilma saldirisi.',
        'Dashing attack that applies Poison and Bound to all targets in your path.': 'Yolundaki tum hedeflere Zehir ve Baglama uygulayan atilma saldirisi.',
        "Steal your foe's strength while it lives. 4 sec duration.": 'Dusman yasadigi surece gucunu calar. 4 saniye surer.',
        "Steal your foe's strength while it lives. 5 sec duration.": 'Dusman yasadigi surece gucunu calar. 5 saniye surer.',
        "Steal your foe's strength while it lives. 6 sec duration.": 'Dusman yasadigi surece gucunu calar. 6 saniye surer.',
        'Strike and drain health from an enemy while it lives. 5 sec duration': 'Dusmana vurur ve yasadigi surece canini emer. 5 saniye surer',
        'Deliver a devastating double strike that Binds a single enemy': 'Tek dusmani Baglayan yikici bir cift darbe indirir',
        'Charges to and severely debuffs target.': 'Hedefe atilir ve agir zayiflatma uygular.',
        'Deliver a single, penetrating strike.': 'Tek ve delici bir darbe indirir.',
        'Deliver a single, penetrating, Staggering strike': 'Tek, delici ve sarsici bir darbe indirir',
        'Deliver a single, penetrating, Staggering strike. Dazes if cast out of Stealth': 'Tek, delici ve sarsici bir darbe indirir. Gizlilikten cikarken kullanilirsa hedefi afallatir.',
        'Fires projectile that applies Cripple, Bind and Armor Bane.': 'Sakatlama, Baglama ve Zirh Kirici uygulayan bir mermi firlatir.',
        'Fires a projectile that applies Cripple, Bind and Armor Bane.': 'Sakatlama, Baglama ve Zirh Kirici uygulayan bir mermi firlatir.',
        'Fires a projectile that applies Cripple, Bind, Weaken and Armor Bane.': 'Sakatlama, Baglama, Zayiflatma ve Zirh Kirici uygulayan bir mermi firlatir.',
        'Fires a projectile that applies Cripple, Bind, Weaken and Armor Bane. Dazes if cast out of Stealth': 'Sakatlama, Baglama, Zayiflatma ve Zirh Kirici uygulayan bir mermi firlatir. Gizlilikten cikarken kullanilirsa hedefi afallatir.',
        'Summon two Shadow Clones to fight alongside you.': 'Yaninda savasacak iki Golge Klonu cagirir.',
        'Summon a pair of melee Undead minions to fight at your command for 8 seconds': 'Emrinde 8 saniye savasacak iki yakin dovus olumsuz hizmetkar cagirir',
        'Summon a pair of melee Undead minions to fight at your command for 10 seconds': 'Emrinde 10 saniye savasacak iki yakin dovus olumsuz hizmetkar cagirir',
        'Summon a pair of melee Undead minions to fight at your command for 12 seconds': 'Emrinde 12 saniye savasacak iki yakin dovus olumsuz hizmetkar cagirir',
        'Summon a ranged Undead minion to fight at your command for 8 seconds': 'Emrinde 8 saniye savasacak menzilli bir olumsuz hizmetkar cagirir',
        'Summon a ranged Undead minion to fight at your command for 10 seconds': 'Emrinde 10 saniye savasacak menzilli bir olumsuz hizmetkar cagirir',
        'Summon a ranged Undead minion to fight at your command for 12 seconds': 'Emrinde 12 saniye savasacak menzilli bir olumsuz hizmetkar cagirir',
        'Summon a ranged Undead minion to fight at your command for 14 seconds': 'Emrinde 14 saniye savasacak menzilli bir olumsuz hizmetkar cagirir',
        'Deliver an strike that Enfeebles your target, applying a 30% Strength Debuff': 'Hedefi Gucsuzlestiren ve %30 guc zayiflatmasi uygulayan bir darbe indirir',
        'Stab your target and apply a 20% Defense Debuff': 'Hedefi bicaklar ve %20 savunma zayiflatmasi uygular',
        'Strike your foes and apply Weaken, Cripple and Armor Bane.': 'Dusmanlara vurur; Zayiflatma, Sakatlama ve Zirh Kirici uygular.',
        'Dash forward, damaging and applying 2 stacks of Bleed to every enemy in your path.': 'Ileri atilir; yolundaki her dusmana hasar verir ve 2 Kanama yuku uygular.',
        'Deliver three slashing blows to your target for #dmg# damage.': 'Hedefe #dmg# hasar veren uc kesici darbe indirir.',
        'Chance to increase your speed for a short time': 'Kisa sureligine hizini artirma sansi verir',
        'Summons your pet.': 'Evcillini cagirir.',
        'Dismisses your active pet.': 'Aktif evcillini gonderir.',
        "Pecks at target's eyes, debilitating them.": 'Hedefin gozlerine saldirir ve onu gucsuzlestirir.',
        'Creates a decoy that distracts your enemies.': 'Dusmanlarinin dikkatini dagitan bir sahte hedef olusturur.',
        'Damages your foes with powerful Storm Breath.': 'Guclu Firtina Nefesiyle dusmanlara hasar verir.',
        'Assaults your enemies with a barrage of fireballs.': 'Dusmanlara ates topu yagmuruyla saldirir.',
        'Swoops past your enemies, damaging them.': 'Dusmanlarinin yanindan dalis yapar ve onlara hasar verir.',
        'Frightens your enemies, Weakening them briefly.': 'Dusmanlarini korkutur ve kisa sureligine zayiflatir.',
        'Makes you and your friends stronger and faster.': 'Seni ve dostlarini daha guclu ve daha hizli yapar.',
        'Grants you and your allies extra Defense.': 'Sana ve muttefiklerine ek savunma verir.',
        'Heals and Cleanses you and your allies.': 'Seni ve muttefiklerini iyilestirir ve arindirir.',
        'Explodes, Burning your enemies.': 'Patlar ve dusmanlarini yakar.',
        'Applies Poison, Armor Bane, and Bleed. Deals bonus damage to target based on missing health.': 'Zehir, Zirh Kirici ve Kanama uygular. Hedefin eksik canina gore bonus hasar verir.',
        'Applies Poison, Armor Bane, and 3 stacks of Bleed. Deals bonus damage to target based on missing health.': 'Zehir, Zirh Kirici ve 3 Kanama yuku uygular. Hedefin eksik canina gore bonus hasar verir.',
        'Version of FrostArmorIce that can be played upside-down and sideways.': 'Buz Zirhi etkisinin ters ve yan oynatilabilen surumudur.',
    'Steal health from a nearby foe': 'Yakindaki bir dusmandan can emer',
    'Deliver a venomous strike that applies Weaken, Cripple and Armor Bane.': 'Zayiflatma, Sakatlama ve Zirh Kirici uygulayan zehirli bir darbe indirir.',
    'If Stealthed, Dazes the target.': 'Gizlilikteysen hedefi afallatir.',
    'Call a Frost Troll to fight with you.': 'Seninle savasmasi icin bir Ayaz Trolu cagirir.',
    'Proc used for melee crit damage.': 'Yakin dovus kritik hasari icin kullanilan tetikleme.',
    'Proc used in place of standard damage when a glancing blow occurs.': 'Siyirma darbesi olustugunda standart hasar yerine kullanilan tetikleme.',
    'Entangles nearby enemies in patchwork rags.': 'Yakindaki dusmanlari yamali caputlarla sarar.',
    'Vampiric Proc used by Lifethirst': 'Yasam Susuzlugu tarafindan kullanilan vampirik tetikleme.',
    'Vampiric pet heal Proc used by Lifethirst': 'Yasam Susuzlugu tarafindan kullanilan vampirik evcil iyilestirme tetiklemesi.',
    'Vampiric Proc used by Devour': 'Yutma tarafindan kullanilan vampirik tetikleme.',
    'Vampiric Proc used by Reaper': 'Bicakci tarafindan kullanilan vampirik tetikleme.',
    'Vampiric Proc used by BloodBond talent': 'Kan Bagi yetenegi tarafindan kullanilan vampirik tetikleme.',
    'Dash used by Shadow Clones': 'Golge Klonlari tarafindan kullanilan atilma.',
    'Restore Health on critical hit': 'Kritik vurusta can yeniler',
    'Chance to recover lost health': 'Kaybedilen cani geri kazanma sansi verir',
    'Summons a Jack-O that follows you around.': 'Seni takip eden bir Jack-O cagirir.',
    'Summons a gargoyle that follows you around.': 'Seni takip eden bir gargoyle cagirir.',
    'Summons a Dragonette that follows you around.': 'Seni takip eden bir kucuk ejder cagirir.',
    'Summons a Spirit that follows you around.': 'Seni takip eden bir ruh cagirir.',
    'Summons a floating skull that follows you around.': 'Seni takip eden ucan bir kafatasi cagirir.',
    'Shroud yourself with shadow energy. Your next attack will deal bonus damage and end the effect.': 'Kendini golge enerjisiyle sarar. Sonraki saldirin bonus hasar verir ve etkiyi bitirir.',
        'Release a debilitating cloud that Weakens and Blinds your foes.': 'Dusmanlarini zayiflatan ve kor eden gucsuzlestirici bir bulut salar.',
        'Release a debilitating cloud that Weakens your foes.': 'Dusmanlarini zayiflatan gucsuzlestirici bir bulut salar.',
        'Dash forward, leaving behind a debilitating cloud that slows and lowers enemy defenses.': 'Ileri atilir ve ardinda dusmanlari yavaslatip savunmalarini dusuren gucsuzlestirici bir bulut birakir.',
        'Create a Shadow Clone that launches an attack on foes around it': 'Etrafindaki dusmanlara saldiran bir Golge Klonu olusturur',
        'Create a Shadow Clone that launches an attack on foes around it. You use the distraction to become elusive.': 'Etrafindaki dusmanlara saldiran bir Golge Klonu olusturur. Bu dikkat daginikligini kullanarak yakalanmasi zor hale gelirsin.',
        'Create a Shadow Clone that launches a Staggering attack on foes around it. You use the distraction to become elusive.': 'Etrafindaki dusmanlara sarsici bir saldiri yapan Golge Klonu olusturur. Bu dikkat daginikligini kullanarak yakalanmasi zor hale gelirsin.',
        'End Sacrifice stance.': 'Fedakarlik durusu biter.',
        'Stance: For duration, casts from health instead of mana. Immune to healing while active.': 'Durus: Sure boyunca mana yerine can harcar. Aktifken iyilestirmeye bagisik olur.',
        'Not in use. Increased speed and melee damage.': 'Kullanimda degil. Hiz ve yakin dovus hasari artar.'
    }).map(([key, target]) => [key.replace(/\.$/, '').trim(), target]));

    const exactValue = exact.get(value.replace(/\.$/, '').trim());
    if (exactValue) {
        return normalizeAscii(exactValue);
    }

    let match = value.match(/^(-?\d+)\s+Second Cooldown\. (\d+)% Defense Boost\. \+(\d+)% Durability\.?$/i);
    if (match) {
        return cleanPowerText(`Bekleme suresi ${Math.abs(Number(match[1]))} saniye azalir. %${match[2]} savunma artisi ve %${match[3]} dayaniklilik kazanir.`);
    }

    match = value.match(/^(-?\d+)\s+Second Cooldown\. (\d+)% Bonus Damage\.?$/i);
    if (match) {
        return cleanPowerText(`Bekleme suresi ${Math.abs(Number(match[1]))} saniye azalir. Ek hasar %${match[2]} artar.`);
    }

    match = value.match(/^(-?\d+)\s+Second Cooldown\. Increased Explosion Damage\.?$/i);
    if (match) {
        return cleanPowerText(`Bekleme suresi ${Math.abs(Number(match[1]))} saniye azalir. Patlama hasari artar.`);
    }

    match = value.match(/^(-?\d+)\s+Second Cooldown\. Explosion Staggers targets\.?$/i);
    if (match) {
        return cleanPowerText(`Bekleme suresi ${Math.abs(Number(match[1]))} saniye azalir. Patlama hedefleri sarsar.`);
    }

    match = value.match(/^Increased Explosion Damage\.?$/i);
    if (match) {
        return 'Patlama hasari artar.';
    }

    match = value.match(/^(\d+)% Defense Boost from shield\. \+(\d+)% Shield Durability\.?$/i);
    if (match) {
        return cleanPowerText(`Kalkandan %${match[1]} savunma artisi ve %${match[2]} kalkan dayanikliligi kazanir.`);
    }

    match = value.match(/^\+(\d+)% Durability\.?$/i);
    if (match) {
        return cleanPowerText(`Dayaniklilik %${match[1]} artar.`);
    }

    match = value.match(/^([+-]?\d+)% Increased max HP\.?$/i);
    if (match) {
        return cleanPowerText(`Azami can %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)% Increased healing received\.?$/i);
    if (match) {
        return cleanPowerText(`Alinan iyilestirme %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)% Resist (Air|Death|Earth|Fire|Ice|Life) damage\.?$/i);
    if (match) {
        return cleanPowerText(`${localizeDamageSchool(match[2])} direnci %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)% Damage to (Air|Death|Earth|Fire|Ice|Life|Mythic) creatures\.?$/i);
    if (match) {
        return cleanPowerText(`${localizeDamageSchool(match[2])} yaratiklara karsi hasar %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^Adds Chilblains to ice-debuffed targets\.?$/i);
    if (match) {
        return 'Buz zayiflatmasi altindaki hedeflere Soguk Yaralari ekler.';
    }

    match = value.match(/^Adds (?:a|another) stack of Chilblains (?:to|vs) ice-debuffed targets\.?$/i);
    if (match) {
        return 'Buz zayiflatmasi altindaki hedeflere bir Soguk Yaralari yuku ekler.';
    }

    match = value.match(/^Ice-debuffed targets gain Chilblains\.?$/i);
    if (match) {
        return 'Buz zayiflatmasi altindaki hedefler Soguk Yaralari kazanir.';
    }

    match = value.match(/^\+(\d+)% Wyrm HP\. \+(\d+)% Bonus Damage vs Ice-Debuffed targets\.?$/i);
    if (match) {
        return cleanPowerText(`Ejder cani %${match[1]} artar. Buz zayiflatmasi altindaki hedeflere karsi ek hasar %${match[2]} artar.`);
    }

    match = value.match(/^\+(\d+)% Wyrm Damage\. \+(\d+)% Bonus Damage vs Ice-Debuffed targets\.?$/i);
    if (match) {
        return cleanPowerText(`Ejder hasari %${match[1]} artar. Buz zayiflatmasi altindaki hedeflere karsi ek hasar %${match[2]} artar.`);
    }

    match = value.match(/^\+(\d+)% trail Damage\.?$/i);
    if (match) {
        return cleanPowerText(`Iz hasari %${match[1]} artar.`);
    }

    match = value.match(/^Increased trail distance\.?$/i);
    if (match) {
        return 'Iz mesafesi artar.';
    }

    match = value.match(/^Add Scorch to trail\.?$/i);
    if (match) {
        return 'Ize Kavurma etkisi ekler.';
    }

    match = value.match(/^Increased dash Damage\s*(#\w+#)?\.?$/i);
    if (match) {
        return cleanPowerText(`Atilma hasari${match[1] ? ` ${match[1]}` : ''} artar.`);
    }

    match = value.match(/^Increased bonus damage\.?$/i);
    if (match) {
        return 'Ek hasar artar.';
    }

    match = value.match(/^Adds Bleed to opening hit\.?$/i);
    if (match) {
        return 'Acilis vurusu Kanama uygular.';
    }

    match = value.match(/^\+(\d+)% Stealth Bonus Damage\.?$/i);
    if (match) {
        return cleanPowerText(`Gizlilik bonus hasari %${match[1]} artar.`);
    }

    match = value.match(/^Increases maximum number of (.+?) Stacks$/i)
        || value.match(/^Increases Maximum Number of (.+?) Stacks$/i)
        || value.match(/^Increases Maximum number of (.+?) Stacks$/i);
    if (match) {
        return cleanPowerText(`Azami ${lowerFirst(localizePowerEffectLabel(match[1]))} yuku sayisi artar.`);
    }

    match = value.match(/^Increases effectiveness of (.+?) and (.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} ve ${lowerFirst(localizePowerEffectLabel(match[2]))} etkisi artar.`);
    }

    match = value.match(/^Increases (.+?) duration$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} suresi artar.`);
    }

    match = value.match(/^Increases (.+?) effectiveness$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} etkisi artar.`);
    }

    match = value.match(/^Increases (.+?) Damage vs\. (.+?) targets$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} hedeflere karsi ${lowerFirst(localizePowerEffectLabel(match[1]))} hasari artar.`);
    }

    match = value.match(/^Increases (.+?) Damage vs\. (.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} hedeflere karsi ${lowerFirst(localizePowerEffectLabel(match[1]))} hasari artar.`);
    }

    match = value.match(/^Increases (.+?) and (.+?) durations$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} ve ${lowerFirst(localizePowerEffectLabel(match[2]))} sureleri artar.`);
    }

    match = value.match(/^Increases (.+?) and (.+?) effectiveness$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} ve ${lowerFirst(localizePowerEffectLabel(match[2]))} etkisi artar.`);
    }

    match = value.match(/^Increases (.+?) Critical Effect$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} kritik etkisi artar.`);
    }

    match = value.match(/^Increases Elemental Critical Effects$/i);
    if (match) {
        return 'Elemental kritik etkiler artar.';
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+Seconds?\s+(.+?)\s+duration\s+and\s+Adds\s+(.+?)\.?$/i);
    if (match) {
        const amount = match[1].replace(/^\+/, '').replace(/^\./, '0.');
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} suresi ${amount} saniye artar ve ${lowerFirst(localizePowerEffectLabel(match[3]))} ekler.`);
    }

    match = value.match(/^Combo from (.+?)\.?$/i);
    if (match) {
        return cleanPowerText(`${localizePowerDisplayName(match[1])} kombosundan gelir.`);
    }

    match = value.match(/^Proc for damage from (.+?)\.?$/i);
    if (match) {
        return cleanPowerText(`${localizePowerDisplayName(match[1])} hasari icin tetiklenir.`);
    }

    match = value.match(/^Strength and Speed Debuff increased to\s+(.+?)%\.?$/i);
    if (match) {
        return cleanPowerText(`Guc ve hiz zayiflatmasi %${match[1]} olur.`);
    }

    match = value.match(/^(-?\d+)\s+Second Cooldown\. Strength and Speed Debuff increased to\s+(.+?)%\.?$/i);
    if (match) {
        return cleanPowerText(`Bekleme suresi ${Math.abs(Number(match[1]))} saniye azalir. Guc ve hiz zayiflatmasi %${match[2]} olur.`);
    }

    match = value.match(/^(\d+)% Defense Boost, (\d+)% Attack Boost, and increased Hate while transformed\.?$/i);
    if (match) {
        return cleanPowerText(`Donusmus halde %${match[1]} savunma artisi, %${match[2]} saldiri artisi ve ek nefret kazanir.`);
    }

    match = value.match(/^(\d+)% Defense Boost while Stealthed\. Speed Penalty (?:reduced to (.+?)|removed)\.?$/i);
    if (match) {
        const penalty = match[2] ? ` Hiz cezasi ${match[2]} olur.` : ' Hiz cezasi kalkar.';
        return cleanPowerText(`Gizlilikteyken %${match[1]} savunma artisi kazanir.${penalty}`);
    }

    match = value.match(/^(\d+)% Defense Boost while Stealthed\.?$/i);
    if (match) {
        return cleanPowerText(`Gizlilikteyken %${match[1]} savunma artisi kazanir.`);
    }

    match = value.match(/^(\d+)% Defense boost while dashing\.?$/i);
    if (match) {
        return cleanPowerText(`Atilma sirasinda %${match[1]} savunma artisi kazanir.`);
    }

    match = value.match(/^Targets have\s+(\d+)%\s+reduced attack speed\.?$/i);
    if (match) {
        return cleanPowerText(`Hedeflerin saldiri hizi %${match[1]} azalir.`);
    }

    match = value.match(/^Unsummon your Ice Armor\.?$/i);
    if (match) {
        return 'Buz Zirhi cagrisini bitirir.';
    }

    match = value.match(/^(\d+)% Damage Boost while in Frost Shock\.?$/i);
    if (match) {
        return cleanPowerText(`Buz Soku etkisindeyken %${match[1]} hasar artisi kazanir.`);
    }

    match = value.match(/^(\d+)% Defense Boost and (\d+)% Speed Boost while firing\.?$/i);
    if (match) {
        return cleanPowerText(`Ates ederken %${match[1]} savunma ve %${match[2]} hiz artisi kazanir.`);
    }

    match = value.match(/^Increased to\s+(\d+)% Attack Boost while active\.?$/i);
    if (match) {
        return cleanPowerText(`Aktifken saldiri artisi %${match[1]} olur.`);
    }

    match = value.match(/^(-?\d+)\s+Mana Cost\. Speed Boost increased to\s+(\d+)%\.?$/i);
    if (match) {
        return cleanPowerText(`Mana bedeli ${Math.abs(Number(match[1]))} azalir. Hiz artisi %${match[2]} olur.`);
    }

    match = value.match(/^Deal extra damage to slowed and immobilized enemies$/i);
    if (match) {
        return 'Yavaslamis ve hareketsiz dusmanlara karsi ek hasar verir.';
    }

    match = value.match(/^Deal extra damage to Bound Targets$/i);
    if (match) {
        return 'Bagli hedeflere karsi ek hasar verir.';
    }

    match = value.match(/^Deal extra damage to (.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} hedeflere karsi ek hasar verir.`);
    }

    match = value.match(/^Gain an? (.+?) bonus while in Stealth$/i);
    if (match) {
        return cleanPowerText(`Gizlilikteyken ${lowerFirst(localizePowerEffectLabel(match[1]))} bonusu kazanir.`);
    }

    match = value.match(/^Gain a Critical Chance bonus vs\. Staggered and Stunned targets$/i);
    if (match) {
        return 'Sarsilmis ve sersemlemis hedeflere karsi kritik sans bonusu kazanir.';
    }

    match = value.match(/^Gain a Critical Chance bonus vs\. Ignited Targets$/i);
    if (match) {
        return 'Tutusmus hedeflere karsi kritik sans bonusu kazanir.';
    }

    match = value.match(/^Gain a Critical Chance bonus vs\. Cursed Targets$/i);
    if (match) {
        return 'Lanetli hedeflere karsi kritik sans bonusu kazanir.';
    }

    match = value.match(/^Gain Bonus Defense vs Projectiles$/i);
    if (match) {
        return 'Mermilere karsi bonus savunma kazanir.';
    }

    match = value.match(/^Gain Bonus Defense vs Cursed Enemies$/i);
    if (match) {
        return 'Lanetli dusmanlara karsi bonus savunma kazanir.';
    }

    match = value.match(/^Gain Bonus Damage vs Cursed Enemies$/i);
    if (match) {
        return 'Lanetli dusmanlara karsi bonus hasar kazanir.';
    }

    match = value.match(/^Gain an? (.+?) bonus vs\. (.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} hedeflere karsi ${lowerFirst(localizePowerEffectLabel(match[1]))} bonusu kazanir.`);
    }

    match = value.match(/^Gain Bonus (.+?) vs(?:\.?) (.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} hedeflere karsi bonus ${lowerFirst(localizePowerEffectLabel(match[1]))} kazanir.`);
    }

    match = value.match(/^Gain healing from Undead Minion Damage$/i);
    if (match) {
        return 'Olumsuz hizmetkarlarin verdigi hasardan sifa kazanir.';
    }

    match = value.match(/^Heal for a percent of your Expertise when entering Stealth$/i);
    if (match) {
        return 'Gizlilige girerken uzmanliginin belirli bir yuzdesi kadar iyilesir.';
    }

    match = value.match(/^Heal for a percent of your Expertise whenever you use a Combat Ability$/i);
    if (match) {
        return 'Bir savas yetenegi kullandiginda uzmanliginin belirli bir yuzdesi kadar iyilesir.';
    }

    match = value.match(/^Gain a Damage Bonus for 3 seconds when you reduce a target to 0 HP\. 10 second cooldown\.?$/i);
    if (match) {
        return 'Bir hedefin canini 0 yaptiginda 3 saniye hasar bonusu kazanir. 10 saniye bekleme suresi vardir.';
    }

    match = value.match(/^Gain an Attack Speed bonus for 5 seconds when you fall below 20% HP\. 15 second cooldown\.?$/i);
    if (match) {
        return 'Canin %20 altina dustugunde 5 saniye saldiri hizi bonusu kazanir. 15 saniye bekleme suresi vardir.';
    }

    match = value.match(/^Gain Recovery for 5 seconds when you fall below 20% HP$/i);
    if (match) {
        return 'Canin %20 altina dustugunde 5 saniye Toparlanma kazanir.';
    }

    match = value.match(/^Gain Regeneration for 5 seconds when you fall below 25% HP$/i);
    if (match) {
        return 'Canin %25 altina dustugunde 5 saniye can yenilenmesi kazanir.';
    }

    match = value.match(/^Damage nearby foes when melee attacked by an Ignited enemy$/i);
    if (match) {
        return 'Tutusan bir dusman yakin dovusla saldirdiginda yakindaki dusmanlara hasar verir.';
    }

    match = value.match(/^Reduce the amount of damage you receive from Damage Over Time effects$/i);
    if (match) {
        return 'Zamanla hasar etkilerinden aldigin hasari azaltir.';
    }

    match = value.match(/^Add a percent of your Expertise to your (Attack|Defense|Max HP)$/i);
    if (match) {
        const stat = match[1] === 'Max HP' ? 'azami canina' : `${lowerFirst(localizePowerEffectLabel(match[1]))} degerine`;
        return cleanPowerText(`Uzmanliginin belirli bir yuzdesini ${stat} ekler.`);
    }

    match = value.match(/^Reduce the effectiveness of Debuffs that decrease your stats$/i);
    if (match) {
        return 'Istatistiklerini azaltan zayiflatmalarin etkisini dusurur.';
    }

    match = value.match(/^Gain Bonus Defense while Sentinel Form is not on Cooldown$/i);
    if (match) {
        return 'Gozcu Formu bekleme suresinde degilken bonus savunma kazanir.';
    }

    match = value.match(/^Set off an AoE burst when you attack a Burning enemy with Fire damage$/i);
    if (match) {
        return 'Yanan bir dusmana ates hasariyla saldirdiginda alan patlamasi tetikler.';
    }

    match = value.match(/^Ice Root takes a percent of your Expertise before breaking$/i);
    if (match) {
        return 'Buz koklemesi kirilmadan once uzmanliginin belirli bir yuzdesi kadar hasar sogurur.';
    }

    match = value.match(/^Freeze takes a percent of your Expertise before breaking$/i);
    if (match) {
        return 'Dondurma etkisi kirilmadan once uzmanliginin belirli bir yuzdesi kadar hasar sogurur.';
    }

    match = value.match(/^Freeze Reduces Target Defense$/i);
    if (match) {
        return 'Dondurma hedefin savunmasini azaltir.';
    }

    match = value.match(/^Gain Bonus Damage to the next Combat Ability cast within 3 seconds of a Master Ability$/i);
    if (match) {
        return 'Usta yetenekten sonraki 3 saniye icinde kullanilan savas yetenegine bonus hasar verir.';
    }

    match = value.match(/^Casting a Combat Ability pauses Master Mana drain briefly$/i);
    if (match) {
        return 'Savas yetenegi kullanmak Usta Mana tuketimini kisa sure duraklatir.';
    }

    match = value.match(/^Reduces Frost Shock Penalty$/i);
    if (match) {
        return 'Buz Soku cezasini azaltir.';
    }

    match = value.match(/^Increased Expertise for 2\.5 sec whenever you summon an Undead Minion$/i);
    if (match) {
        return 'Olumsuz hizmetkar cagirdiginda 2.5 saniye uzmanlik artisi kazanir.';
    }

    match = value.match(/^Heal targets gain Defense Bonus for 1 sec$/i);
    if (match) {
        return 'Iyilestirilen hedefler 1 saniye savunma bonusu kazanir.';
    }

    match = value.match(/^Sacred gives Defense Bonus$/i);
    if (match) {
        return 'Kutsal etki savunma bonusu verir.';
    }

    match = value.match(/^Increases Blinded Miss Chance$/i);
    if (match) {
        return 'Kor edilen hedeflerin iskalama sansi artar.';
    }

    match = value.match(/^Increased Healing on targets with less than 20% Health$/i);
    if (match) {
        return 'Cani %20 altindaki hedeflerde sifa artar.';
    }

    match = value.match(/^10 second cooldown$/i);
    if (match) {
        return '10 saniye bekleme suresi vardir.';
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+second\s+(.+?)\s+duration$/i);
    if (match) {
        const amount = match[1].replace(/^\+/, '').replace(/^\./, '0.');
        return cleanPowerText(`${localizePowerDisplayName(match[2])} suresi ${amount} saniye artar.`);
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)%?)\s+(.+?)\s+(damage|healing|effectiveness|duration|durability|health regen|life siphon|attack leech|ghoul attack|defense|defense boost|melee damage|poison damage|base damage|DoT)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerDisplayName(match[2])} ${modifierNoun(match[3])} ${formatModifierAmount(match[1])} artar.`);
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+second\s+(.+?)\s+duration$/i);
    if (match) {
        return cleanPowerText(`${localizePowerDisplayName(match[2])} suresi ${match[1].replace(/^\+/, '')} saniye artar.`);
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+second\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} ${match[1].replace(/^\+/, '')} saniye artar.`);
    }

    match = value.match(/^Adds?\s+(\d+)\s+Stacks?\s+of\s+(.+?)\s+to\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[3])} icin ${match[1]} ${lowerFirst(localizePowerEffectLabel(match[2]))} yuku ekler.`);
    }

    match = value.match(/^(.+?) adds an? stack of (.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} 1 ${lowerFirst(localizePowerEffectLabel(match[2]))} yuku ekler.`);
    }

    match = value.match(/^(.+?) adds (\d+) stacks of (.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} ${match[2]} ${lowerFirst(localizePowerEffectLabel(match[3]))} yuku ekler.`);
    }

    match = value.match(/^Increase Defense during (.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} sirasinda savunmayi artirir.`);
    }

    match = value.match(/^(.+?) Weakens targets$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} hedefleri zayiflatir.`);
    }

    match = value.match(/^(.+?) reduces speed$/i);
    if (match) {
        if (/^Armor Breaker$/i.test(match[1])) {
            return 'Zirh Kiran hedefleri yavaslatir.';
        }
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} hizi azaltir.`);
    }

    match = value.match(/^Permafrost Clone dash Chills$/i);
    if (match) {
        return 'Kalici Buz Klonu atilmasi hedefleri usutur.';
    }

    match = value.match(/^Bonus damage per stack of (.+)$/i);
    if (match) {
        return cleanPowerText(`Her ${lowerFirst(localizePowerEffectLabel(match[1]))} yuku basina bonus hasar verir.`);
    }

    match = value.match(/^Bolster ghoul shots add 1% weaken$/i);
    if (match) {
        return 'Guclendirilmis gulyabani atislari %1 zayiflatma ekler.';
    }

    match = value.match(/^For\s+(\d+)\s+seconds?,\s+create an aura that grants nearby Allies an?\s+(.+?)\s+Attack and Expertise boost$/i);
    if (match) {
        return cleanPowerText(`${match[1]} saniyeligine yakindaki muttefiklere ${match[2]} saldiri ve uzmanlik artisi veren bir aura olusturur.`);
    }

    match = value.match(/^(-?\d+)\s+Mana Cost(?:\s+and\s+Requirement)?$/i);
    if (match) {
        const suffix = /Requirement/i.test(value) ? 'maliyeti ve gereksinimi' : 'maliyeti';
        return cleanPowerText(manaChangeText(match[1], suffix));
    }

    match = value.match(/^(-?\d+)\s+Mana Requirement(?:\s+to\s+enter\s+stance)?$/i);
    if (match) {
        return cleanPowerText(manaChangeText(match[1], 'gereksinimi'));
    }

    match = value.match(/^(-?\d+)\s+Mana$/i);
    if (match) {
        return cleanPowerText(manaChangeText(match[1]));
    }

    match = value.match(/^(-?\d+)\s+Second Cooldown$/i);
    if (match) {
        const numeric = Math.abs(Number(match[1]));
        const verb = Number(match[1]) < 0 ? 'azalir' : 'artar';
        return cleanPowerText(`Bekleme suresi ${numeric} saniye ${verb}.`);
    }

    match = value.match(/^(-?\d+)%\s+Cast Time$/i);
    if (match) {
        const numeric = Math.abs(Number(match[1]));
        const verb = Number(match[1]) < 0 ? 'azalir' : 'artar';
        return cleanPowerText(`Kullanim suresi %${numeric} ${verb}.`);
    }

    match = value.match(/^([+-]?\d+)%\s+Attack Boost$/i);
    if (match) {
        return cleanPowerText(`Saldiri gucu %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)%\s+Attack Damage$/i);
    if (match) {
        return cleanPowerText(`Saldiri hasari %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)%\s+Attack Speed reduction$/i);
    if (match) {
        return cleanPowerText(`Saldiri hizi azaltmasi %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)%\s+Defense Boost(?:\s+during\s+cast)?$/i);
    if (match) {
        const prefix = /during\s+cast/i.test(value) ? 'Kullanim sirasinda ' : '';
        return cleanPowerText(`${prefix}savunma %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^(\d+)%\s+Ignite Bonus$/i);
    if (match) {
        return cleanPowerText(`Tutusturma hasari %${match[1]} artar.`);
    }

    match = value.match(/^(\d+)%\s+Expertise Bonus per unique condition$/i);
    if (match) {
        return cleanPowerText(`Her farkli kosul icin %${match[1]} uzmanlik bonusu verir.`);
    }

    match = value.match(/^(\d+)%\s+Expertise Bonus Cap$/i);
    if (match) {
        return cleanPowerText(`Uzmanlik bonusu ust siniri %${match[1]} olur.`);
    }

    match = value.match(/^(\d+)%\s+Expertise bonus damage per condition$/i);
    if (match) {
        return cleanPowerText(`Her kosul icin %${match[1]} uzmanlik bonus hasari verir.`);
    }

    match = value.match(/^(\d+)%\s+bonus cap$/i);
    if (match) {
        return cleanPowerText(`Bonus ust siniri %${match[1]} olur.`);
    }

    match = value.match(/^(\d+)%\s+Expertise Damage bonus vs\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} hedeflere karsi %${match[1]} uzmanlik hasari bonusu verir.`);
    }

    match = value.match(/^(\d+)%\s+Bonus Damage vs\s+(.+?)\s+targets$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} hedeflere karsi %${match[1]} bonus hasar verir.`);
    }

    match = value.match(/^(\d+)%\s+Minion heal over time$/i);
    if (match) {
        return cleanPowerText(`Hizmetkarlari zamanla %${match[1]} iyilestirir.`);
    }

    match = value.match(/^([+-]?\d+)%\s+trail Damage$/i);
    if (match) {
        return cleanPowerText(`Iz hasari %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)\s+second duration$/i);
    if (match) {
        return cleanPowerText(`Sure ${match[1].replace(/^\+/, '')} saniye artar.`);
    }

    match = value.match(/^(\d+)%\s+Heal over\s+(\d+)\s+sec$/i);
    if (match) {
        return cleanPowerText(`${match[2]} saniye boyunca %${match[1]} iyilestirme yapar.`);
    }

    match = value.match(/^([+-]?\d+)%\s+secondary healing$/i);
    if (match) {
        return cleanPowerText(`Ikincil iyilestirme %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)\s+(Weaken|Cripple|Burn|Scorch|Bind)$/i);
    if (match) {
        return cleanPowerText(`${Math.abs(Number(match[1]))} ${lowerFirst(localizePowerEffectLabel(match[2]))} yuku ekler.`);
    }

    match = value.match(/^Strength Bonus increased to\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`Guc bonusu ${match[1]} olur.`);
    }

    match = value.match(/^([+-]?\d+)\s+Mana Cost per attack$/i);
    if (match) {
        return cleanPowerText(`Saldiri basina mana maliyeti ${Math.abs(Number(match[1]))} azalir.`);
    }

    match = value.match(/^(\d+)%\s+Defense(?:\s+boost)?\s+during\s+(charge|dash|cast)$/i);
    if (match) {
        const phase = match[2].toLowerCase() === 'charge' ? 'hucum' : match[2].toLowerCase() === 'dash' ? 'atilma' : 'kullanim';
        return cleanPowerText(`${phase} sirasinda savunma %${match[1]} artar.`);
    }

    match = value.match(/^(\d+)%\s+Defense boost for\s+(.+?)\s+seconds?\s+when cast$/i);
    if (match) {
        return cleanPowerText(`Kullanildiginda ${match[2]} saniye boyunca savunma %${match[1]} artar.`);
    }

    match = value.match(/^Increased Damage Increased AoE(?:\s*(#\w+#))?$/i);
    if (match) {
        return cleanPowerText(`Hasar ve alan etkisi artar${match[1] ? ` ${match[1]}` : ''}.`);
    }

    match = value.match(/^Adds?\s+an?\s+additional\s+stack\s+of\s+(.+?)$/i);
    if (match) {
        return cleanPowerText(`Ek bir ${lowerFirst(localizePowerEffectLabel(match[1]))} yuku ekler.`);
    }

    match = value.match(/^Adds?\s+(?:an?\s+)?stack\s+of\s+(.+?)\s+per\s+hit$/i);
    if (match) {
        return cleanPowerText(`Her vurusta 1 ${lowerFirst(localizePowerEffectLabel(match[1]))} yuku ekler.`);
    }

    match = value.match(/^([+-]?\d+)%\s+Wyrm\s+(HP|Damage)$/i);
    if (match) {
        const label = match[2].toLowerCase() === 'hp' ? 'can' : 'hasar';
        return cleanPowerText(`Ejder ${label} degeri %${match[1].replace(/^\+/, '')} artar.`);
    }

    match = value.match(/^([+-]?\d+)\s+sec\s+(.+?)\s+Duration$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} suresi ${Math.abs(Number(match[1]))} saniye artar.`);
    }

    match = value.match(/^Inflicts\s+(.+?)\s+Armor Debuff$/i);
    if (match) {
        return cleanPowerText(`${match[1]} zirh zayiflatmasi uygular.`);
    }

    match = value.match(/^Applies an?\s+(.+?)\s+Defense Debuff$/i);
    if (match) {
        return cleanPowerText(`${match[1]} savunma zayiflatmasi uygular.`);
    }

    match = value.match(/^Grants?\s+(.+?)\s+Dash Armor$/i);
    if (match) {
        return cleanPowerText(`Atilma sirasinda ${match[1]} zirh verir.`);
    }

    match = value.match(/^Deals?\s+(\d+)\s+stacks?\s+of\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`${match[1]} ${lowerFirst(localizePowerEffectLabel(match[2]))} yuku uygular.`);
    }

    match = value.match(/^Each dagger adds Armor Bane$/i);
    if (match) {
        return cleanPowerText('Her hancer Zirh Kirici etkisi ekler.');
    }

    match = value.match(/^Shots damage and heal in AoE\s*(#\w+#)?$/i);
    if (match) {
        return cleanPowerText(`Atislar alanda hasar verir ve iyilestirir${match[1] ? ` ${match[1]}` : ''}.`);
    }

    match = value.match(/^Staggers?\s+(?:the\s+)?targets?$/i);
    if (match) {
        return cleanPowerText(/targets/i.test(value) ? 'Hedefleri sarsar.' : 'Hedefi sarsar.');
    }

    match = value.match(/^Stuns?\s+(.+?)\s+target$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} hedefini sersemletir.`);
    }

    match = value.match(/^If Stealthed,\s+Dazes target$/i);
    if (match) {
        return cleanPowerText('Gizliyken kullanilirsa hedefi afallatir.');
    }

    match = value.match(/^Improved\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} iyilesir.`);
    }

    match = value.match(/^Increased Damage Increased AoE(?:\s*(#\w+#))?$/i);
    if (match) {
        return cleanPowerText(`Hasar ve alan etkisi artar${match[1] ? ` ${match[1]}` : ''}.`);
    }

    match = value.match(/^Increases?\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} artar.`);
    }

    match = value.match(/^Increased\s+(.+)$/i);
    if (match && !/\b(?:to|per)\b/i.test(match[1])) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} artar.`);
    }

    match = value.match(/^Increased\s+(.+?)\s+to\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[2])} icin ${lowerFirst(localizePowerEffectLabel(match[1]))} artar.`);
    }

    match = value.match(/^Increased\s+(.+?)\s+per\s+(.+)$/i);
    if (match) {
        return cleanPowerText(`Her ${lowerFirst(localizePowerEffectLabel(match[2]))} icin ${lowerFirst(localizePowerEffectLabel(match[1]))} artar.`);
    }

    match = value.match(/^Adds?\s+(.+?)\s+to\s+last\s+hit\.?$/i);
    if (match) {
        return cleanPowerText(`Son vurusa ${lowerFirst(localizePowerEffectLabel(match[1]))} etkisi ekler.`);
    }

    match = value.match(/^Adds?\s+(.+?)\s+to\s+(?:the\s+)?(.+?)$/i);
    if (match) {
        return cleanPowerText(`${lowerFirst(localizePowerEffectLabel(match[2]))} icin ${lowerFirst(localizePowerEffectLabel(match[1]))} etkisi ekler.`);
    }

    match = value.match(/^Adds?\s+an?\s+extra\s+stack\s+of\s+(.+?)\.?$/i);
    if (match) {
        return cleanPowerText(`Ek bir ${lowerFirst(localizePowerEffectLabel(match[1]))} yuku ekler.`);
    }

    match = value.match(/^Adds?\s+(?:(\d+)\s+stacks?|an?\s+stack)\s+of\s+(.+?)\.?$/i);
    if (match) {
        const count = match[1] || '1';
        return cleanPowerText(`${count} ${lowerFirst(localizePowerEffectLabel(match[2]))} yuku ekler.`);
    }

    match = value.match(/^Adds?\s+(.+?)\.?$/i);
    if (match) {
        return cleanPowerText(`${localizePowerEffectLabel(match[1])} etkisi ekler.`);
    }

    match = value.match(/^([+-]?\d+(?:\.\d+)?%?)\s+(.+?)\s+damage$/i);
    if (match) {
        return cleanPowerText(`${localizePowerDisplayName(match[2])} hasari ${match[1]}`);
    }

    match = value.match(/^([+-]?\d+(?:\.\d+)?%?)\s+(.+?)\s+healing$/i);
    if (match) {
        return cleanPowerText(`${localizePowerDisplayName(match[2])} iyilestirmesi ${match[1]}`);
    }

    match = value.match(/^([+-]?\d+)\s+Second Stun duration(?:,?\s+(.+))?$/i);
    if (match) {
        const extra = match[2] ? ` ${localizePowerSentence(match[2])}` : '';
        const numeric = Math.abs(Number(match[1]));
        const verb = Number(match[1]) < 0 ? 'azalir' : 'artar';
        return cleanPowerText(`Sersemletme suresi ${numeric} saniye ${verb}.${extra}`);
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)%?)\s+(.+?)\s+duration$/i);
    if (match) {
        return cleanPowerText(`${localizePowerDisplayName(match[2])} suresi ${formatModifierAmount(match[1])} artar.`);
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+second\s+(.+?)\s+duration$/i);
    if (match) {
        return cleanPowerText(`${localizePowerDisplayName(match[2])} suresi ${match[1].replace(/^\+/, '')} saniye artar.`);
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)%)\s+(.+?)\s+(.+)$/i);
    if (match && /damage|defense|duration|healing|regen|leech|siphon|attack|reduction|dot/i.test(match[3])) {
        return cleanPowerText(`${localizePowerDisplayName(match[2])} ${modifierNoun(match[3])} ${formatModifierAmount(match[1])} artar.`);
    }

    match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)%)\s+([A-Za-z][A-Za-z\s']+)$/i);
    if (match) {
        return cleanPowerText(`${localizePowerLabel(match[2])} ${match[1]}`);
    }

    match = value.match(/^Tendril speed reduction is\s+(.+?)$/i);
    if (match) {
        return cleanPowerText(`Sarmasik kolu hiz azaltmasi ${match[1]} olur`);
    }

    match = value.match(/^(-?\d+)\s+Mana Cost\.?$/i);
    if (match) {
        return cleanPowerText(`Mana bedeli ${match[1]} degisir.`);
    }

    match = value.match(/^Defense Buff (?:increased|raised) to\s+(.+?)\.?$/i);
    if (match) {
        return cleanPowerText(`Savunma guclendirmesi ${match[1]} olur.`);
    }

    match = value.match(/^Target gains\s+(.+?)\s+Defense Buff for a second\.?$/i);
    if (match) {
        return cleanPowerText(`Hedef 1 saniye ${match[1]} savunma guclendirmesi kazanir.`);
    }

    match = value.match(/^Grants party a\s+(.+?)\s+Defense Boost for\s+(.+?)\s+seconds?\.?$/i);
    if (match) {
        return cleanPowerText(`Gruba ${match[2]} saniye ${match[1]} savunma artisi verir.`);
    }

    match = value.match(/^Debuff increased to\s+(.+?)\.?$/i);
    if (match) {
        const debuff = match[1]
            .replace(/Attack/gi, 'Saldiri')
            .replace(/Speed/gi, 'Hiz')
            .replace(/\band\b/gi, 've');
        return cleanPowerText(`Zayiflatma ${debuff} olur.`);
    }

    match = value.match(/^Defense Buff increased to\s+(.+?)\s*and Increased Damage\s+(#\w+#)\.?$/i);
    if (match) {
        return cleanPowerText(`Savunma guclendirmesi ${match[1]} olur ve hasar ${match[2]} artar.`);
    }

    match = value.match(/^Defense Penalty reduced to\s+(.+?)\.?$/i);
    if (match) {
        return cleanPowerText(`Savunma cezasi ${match[1]} olur.`);
    }

    match = value.match(/^Increased Health Regen\. Defense Penalty removed\.?$/i);
    if (match) {
        return 'Can yenilenmesi artar. Savunma cezasi kalkar.';
    }

    match = value.match(/^Increased Health Regen\.?$/i);
    if (match) {
        return 'Can yenilenmesi artar.';
    }

    match = value.match(/^Defense Penalty removed\.?$/i);
    if (match) {
        return 'Savunma cezasi kalkar.';
    }

    match = value.match(/^Speed Penalty removed\.?$/i);
    if (match) {
        return 'Hiz cezasi kalkar.';
    }

    match = value.match(/^Speed Penalty reduced to\s+(.+?)\.?$/i);
    if (match) {
        return cleanPowerText(`Hiz cezasi ${match[1]} olur.`);
    }

    match = value.match(/^For damage from Retribution\. No longer a proc so it can have a cast time\.?$/i);
    if (match) {
        return 'Intikam hasari icindir. Artik tetikleme degil; bu yuzden kullanim suresi olabilir.';
    }

    match = value.match(/^(\d+)% Defense Boost from shield\. \+(\d+)% Shield Durability\.?$/i);
    if (match) {
        return cleanPowerText(`Kalkandan %${match[1]} savunma artisi ve %${match[2]} kalkan dayanikliligi kazanir.`);
    }

    match = value.match(/^(-?\d+)\s+Second Cooldown\. (\d+)% Defense Boost\. \+(\d+)% Durability\.?$/i);
    if (match) {
        return cleanPowerText(`Bekleme suresi ${Math.abs(Number(match[1]))} saniye azalir. %${match[2]} savunma artisi ve %${match[3]} dayaniklilik kazanir.`);
    }

    match = value.match(/^(\d+)% Defense Boost\.?$/i);
    if (match) {
        return cleanPowerText(`%${match[1]} savunma artisi kazanir.`);
    }

    match = value.match(/^\+(\d+)% Durability\.?$/i);
    if (match) {
        return cleanPowerText(`Dayaniklilik %${match[1]} artar.`);
    }

    match = value.match(/^\+(\d+)% Wyrm HP\. \+(\d+)% Bonus Damage vs Ice-Debuffed targets\.?$/i);
    if (match) {
        return cleanPowerText(`Ejder cani %${match[1]} artar. Buz zayiflatmasi altindaki hedeflere karsi %${match[2]} bonus hasar verir.`);
    }

    match = value.match(/^\+(\d+)% Wyrm HP\.?$/i);
    if (match) {
        return cleanPowerText(`Ejder cani %${match[1]} artar.`);
    }

    match = value.match(/^Clones have \+15% (HP|Defense) and increased Hate\.?$/i);
    if (match) {
        const stat = match[1].toLowerCase() === 'hp' ? 'can' : 'savunma';
        return cleanPowerText(`Klonlar %15 ${stat} ve ek nefret kazanir.`);
    }

    match = value.match(/^Clones have \+15% (HP|Defense)\.?$/i);
    if (match) {
        const stat = match[1].toLowerCase() === 'hp' ? 'can' : 'savunma';
        return cleanPowerText(`Klonlar %15 ${stat} kazanir.`);
    }

    match = value.match(/^increased Hate\.?$/i);
    if (match) {
        return 'Ek nefret kazanir.';
    }

    match = value.match(/^Speed Boost increased to\s+(\d+)%\.?$/i);
    if (match) {
        return cleanPowerText(`Hiz artisi %${match[1]} olur.`);
    }

    match = value.match(/^Cleanses Movement CC when cast\.?$/i);
    if (match) {
        return 'Kullanildiginda hareket kisitlamalarini arindirir.';
    }

    match = value.match(/^(\d+)% Speed Boost for 1 second\.?$/i);
    if (match) {
        return cleanPowerText(`1 saniye %${match[1]} hiz artisi verir.`);
    }

    return cleanPowerText(translateTokenized(value, { rootName: 'PlayerPowerTypes', tagName: 'Description' }));
}

function localizePowerDescription(source) {
    const value = String(source ?? '');
    if (!value.trim() || /^[-]+$/.test(value.trim())) {
        return normalizeAscii(value);
    }

    const curseDamage = value.match(/^Gain Bonus Damage vs Cursed Enemies@Defense:(.*)$/i);
    if (curseDamage) {
        return cleanPowerText(`Lanetli dusmanlara karsi bonus hasar kazanir.@Bonus Hasar:${curseDamage[1]}`);
    }

    const parts = value.split('@');
    const localized = parts.map((part, index) => {
        return index === 0 ? localizePowerParagraph(part) : localizePowerStatSegment(part);
    });

    return cleanPowerText(localized.join('@'));
}

function fallbackText(source, options = {}) {
    const tag = String(options.tagName || '');
    const root = String(options.rootName || '');
    const id = stableId(source);

    if (/Name$/.test(tag) || tag === 'DyeName' || tag === 'DisplayName') {
        if (/LevelTypes/i.test(root)) {
            return `Yerel Bolge ${id}`;
        }
        if (/MissionTypes/i.test(root)) {
            return `Yerel Gorev ${id}`;
        }
        if (/Power|Ability|Node/i.test(root)) {
            return `Yerel Yetenek ${id}`;
        }
        if (/Pet|Mount/i.test(root)) {
            return `Yerel Yoldas ${id}`;
        }
        if (/Gear|Charm|Magic|Material|Consumable|Lockbox|RoyalStore|Egg|Dye/i.test(root)) {
            return `Yerel Esya ${id}`;
        }
        return `Yerel Ad ${id}`;
    }

    if (/LockedMessage/i.test(tag)) {
        return `Bu gecis henuz acilmadi. Kod ${id}.`;
    }

    return `Turkce aciklama ${id}.`;
}

function localizeText(source, options = {}) {
    const value = String(source ?? '');
    if (!value.trim() || !hasEnglishLetters(value)) {
        return normalizeAscii(value);
    }
    const compactValue = value.trim().replace(/\s+/g, ' ');
    const tag = String(options.tagName || '');
    const root = String(options.rootName || '');

    if (isPowerTextContext(options)) {
        if (options.tagName === 'DisplayName') {
            return localizePowerDisplayName(value);
        }
        if (options.tagName === 'Description' || options.tagName === 'UpgradeDescription') {
            return localizePowerDescription(value);
        }
    }

    const templateMatches = [
        [/^Must be level\s+(.+?)\s+to upgrade$/i, (_match, level) => `Yukseltmek icin seviye ${level} gerekli`],
        [/^Busy upgrading\s+(.+)$/i, (_match, thing) => `${localizeText(thing, options)} yukseltmesi suruyor`],
        [/^Summon\s+(.+)$/i, (_match, thing) => `${localizeText(thing, options)} cagir`],
        [/^Unlocks all Rank\s+(\d+)\s+abilities for training$/i, (_match, rank) => `Tum Kademe ${rank} yeteneklerinin egitimini acar`],
        [/^Unlocks Rank\s+(\d+)\s+charm recipes$/i, (_match, rank) => `Kademe ${rank} tilsim tariflerini acar`],
        [/^Unlocks the next\s+(\d+)\s+talent points for training$/i, (_match, count) => `Sonraki ${count} yetenek puaninin egitimini acar`],
        [/^Increases the max pet level cap by\s+(\d+)$/i, (_match, amount) => `Azami evcil seviyesini ${amount} artirir`],
        [/^Increase Gear Finding by X Pet Level$/i, () => 'Evcil seviyesine gore ekipman bulma sansini artirir'],
        [/^Increase Gold Finding by X Pet Level$/i, () => 'Evcil seviyesine gore altin bulma sansini artirir'],
        [/^Increase Material Finding by X Pet Level$/i, () => 'Evcil seviyesine gore malzeme bulma sansini artirir'],
        [/^Increase XP Gain by X Pet Level$/i, () => 'Evcil seviyesine gore XP kazancini artirir']
    ];

    for (const [pattern, build] of templateMatches) {
        const match = value.match(pattern);
        if (match) {
            return normalizeAscii(build(...match));
        }
    }

    if (EXACT_PHRASES.has(value) || PROPER_PHRASES.has(value) || EXACT_PHRASES.has(compactValue) || PROPER_PHRASES.has(compactValue)) {
        return normalizeAscii(EXACT_PHRASES.get(value) || PROPER_PHRASES.get(value) || EXACT_PHRASES.get(compactValue) || PROPER_PHRASES.get(compactValue));
    }

    const translated = translateTokenized(value, options);
    if (!translated || normalizeAscii(translated).trim() === normalizeAscii(value).trim()) {
        return normalizeAscii(fallbackText(value, options));
    }

    if (tag === 'DisplayName' && /CharmTypes|MagicTypes|GearTypes|ConsumableTypes|LockboxTypes|RoyalStoreTypes|EggTypes|MaterialTypes/i.test(root)) {
        return titleCaseAscii(translated);
    }

    if (tag === 'DisplayName' && /BuildingTypes/i.test(root)) {
        return titleCaseAscii(translated);
    }

    return normalizeAscii(translated);
}

module.exports = {
    EXACT_PHRASES,
    PROPER_PHRASES,
    WORDS,
    fallbackText,
    hasEnglishLetters,
    localizeText,
    normalizeAscii,
    stableId,
    titleCaseAscii
};
