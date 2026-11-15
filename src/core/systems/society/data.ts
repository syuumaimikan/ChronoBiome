/**
 * Data for civilisation: goods, mineral deposits, the technology graph (about
 * 100 nodes following real history, plus a magic branch), buildings, forms of
 * government and religious ideas. Effects are summed over adopted
 * technologies (weighted by how widely each is adopted) and built buildings.
 */

export const GOODS = [
  { id: 'food', name: '食料', base: 1 },
  { id: 'wood', name: '木材', base: 1.5 },
  { id: 'stone', name: '石材', base: 2 },
  { id: 'copper', name: '銅', base: 6 },
  { id: 'tin', name: '錫', base: 10 },
  { id: 'iron', name: '鉄', base: 5 },
  { id: 'coal', name: '石炭', base: 3 },
  { id: 'oil', name: '石油', base: 6 },
  { id: 'tools', name: '道具', base: 8 },
  { id: 'cloth', name: '布', base: 4 },
  { id: 'luxury', name: '贅沢品', base: 20 },
  { id: 'mana', name: '魔晶', base: 30 },
] as const;
export type GoodId = (typeof GOODS)[number]['id'];
export const NG = GOODS.length;
export const G = Object.fromEntries(GOODS.map((g, i) => [g.id, i])) as Record<GoodId, number>;

export const DEP = { copper: 1, tin: 2, iron: 4, coal: 8, oil: 16, uranium: 32, gold: 64, mana: 128 } as const;
export const DEPOSIT_NAMES: [number, string][] = [
  [DEP.copper, '銅'], [DEP.tin, '錫'], [DEP.iron, '鉄'], [DEP.coal, '石炭'], [DEP.oil, '石油'], [DEP.uranium, 'ウラン'], [DEP.gold, '金'], [DEP.mana, '魔晶'],
];

/** Effect channels shared by technologies and buildings. */
export const FX = [
  'food', 'research', 'military', 'health', 'trade', 'energy', 'fossil', 'renew', 'literacy', 'admin',
  'culture', 'sail', 'space', 'magic', 'urban', 'prod', 'defense', 'piety', 'astro', 'mana',
] as const;
export type FxId = (typeof FX)[number];
export const NFX = FX.length;
export const F = Object.fromEntries(FX.map((f, i) => [f, i])) as Record<FxId, number>;
type Fx = Partial<Record<FxId, number>>;

export const ERAS = ['旧石器', '新石器', '青銅器', '鉄器', '古典', '中世', '近世', '産業', '近代', '情報', '宇宙'] as const;
const ERA_COST = [300, 2200, 5000, 9000, 15000, 26000, 42000, 68000, 110000, 170000, 260000];

export interface Tech {
  id: string;
  name: string;
  era: number;
  field: string;
  req: string[];
  cost: number;
  fx: Fx;
  /** Deposits that must be reachable (all bits). */
  res: number;
  magic: boolean;
  /** Index into TECHS (filled below). */
  index: number;
  reqIdx: number[];
}

function t(id: string, name: string, era: number, field: string, req: string[], costMul: number, fx: Fx, res = 0): Tech {
  return { id, name, era, field, req, cost: Math.round(ERA_COST[era] * costMul), fx, res, magic: field === '魔法', index: -1, reqIdx: [] };
}

export const TECHS: Tech[] = [
  // ---- 旧石器
  t('stone_tools', '打製石器', 0, '道具', [], 0.6, { prod: 0.1 }),
  t('fire', '火の利用', 0, 'エネルギー', [], 0.6, { health: 0.05, energy: 0.1 }),
  t('foraging', '狩猟採集の知恵', 0, '農業', ['stone_tools'], 0.8, { food: 0.15 }),
  t('clothing', '衣服', 0, '材料', ['stone_tools'], 0.8, { health: 0.05 }),
  t('ritual', '埋葬と儀礼', 0, '統治', ['fire'], 0.7, { culture: 0.1, piety: 0.1 }),
  t('bow', '弓矢', 0, '軍事', ['stone_tools'], 1, { military: 0.2, food: 0.05 }),
  t('raft', '丸木舟', 0, '輸送', ['stone_tools', 'fire'], 1, { sail: 0.5, trade: 0.3 }),
  t('cave_art', '洞窟壁画', 0, '記録', ['ritual'], 0.9, { culture: 0.1, research: 0.05 }),
  // ---- 新石器
  t('agriculture', '農耕', 1, '農業', ['foraging', 'fire'], 1.6, { food: 6, urban: 0.02 }),
  t('husbandry', '牧畜', 1, '農業', ['agriculture'], 1, { food: 2, prod: 0.1, military: 0.1 }),
  t('pottery', '土器', 1, '材料', ['fire', 'agriculture'], 0.8, { food: 1, prod: 0.1 }),
  t('weaving', '織物', 1, '材料', ['agriculture'], 0.8, { prod: 0.1, health: 0.05 }),
  t('polished_stone', '磨製石器', 1, '道具', ['stone_tools', 'agriculture'], 0.7, { prod: 0.15 }),
  t('mudbrick', '日干し煉瓦', 1, '建築', ['agriculture'], 0.8, { urban: 0.02, defense: 0.1 }),
  t('irrigation', '灌漑', 1, '農業', ['agriculture', 'pottery'], 1.2, { food: 3 }),
  t('calendar', '暦', 1, '科学', ['ritual', 'agriculture'], 1, { food: 0.5, research: 0.1, astro: 0.2 }),
  t('sailing', '帆船', 1, '輸送', ['raft', 'weaving'], 1.1, { sail: 1, trade: 1 }),
  // ---- 青銅器
  t('copper', '銅の精錬', 2, '冶金', ['pottery', 'fire'], 0.9, { prod: 0.2, military: 0.1 }, DEP.copper),
  t('bronze', '青銅', 2, '冶金', ['copper'], 1.1, { prod: 0.25, military: 0.4 }, DEP.copper | DEP.tin),
  t('wheel', '車輪', 2, '輸送', ['pottery'], 1, { trade: 1, prod: 0.1 }),
  t('writing', '文字', 2, '記録', ['calendar', 'pottery'], 1.4, { literacy: 0.15, research: 0.3, admin: 1 }),
  t('mathematics', '数学', 2, '科学', ['writing'], 1, { research: 0.2 }),
  t('plow', '犂', 2, '農業', ['husbandry', 'polished_stone'], 1, { food: 3 }),
  t('law', '法典', 2, '統治', ['writing'], 1, { admin: 1.5, culture: 0.1 }),
  t('astronomy', '天文学', 2, '科学', ['calendar', 'mathematics'], 1, { research: 0.1, astro: 0.5 }),
  t('chariot', '戦車', 2, '軍事', ['wheel', 'bronze', 'husbandry'], 1, { military: 0.5 }),
  t('masonry', '石造建築', 2, '建築', ['mudbrick', 'copper'], 1, { urban: 0.02, defense: 0.2 }),
  // ---- 鉄器
  t('iron', '製鉄', 3, '冶金', ['copper'], 1.3, { prod: 0.3, military: 0.5, food: 1 }, DEP.iron),
  t('coinage', '貨幣', 3, '統治', ['writing', 'copper'], 1, { trade: 1.5 }),
  t('alphabet', 'アルファベット', 3, '記録', ['writing'], 1, { literacy: 0.15 }),
  t('philosophy', '哲学', 3, '科学', ['alphabet', 'mathematics'], 1.2, { research: 0.3, culture: 0.2 }),
  t('roads', '街道', 3, '輸送', ['wheel', 'masonry'], 1, { trade: 1.5, admin: 1 }),
  t('galley', '櫂船', 3, '輸送', ['sailing', 'copper'], 1, { sail: 0.5, trade: 1, military: 0.2 }),
  t('iron_weapons', '鉄の武具', 3, '軍事', ['iron'], 0.9, { military: 0.6 }),
  t('aqueduct', '水道', 3, '建築', ['masonry', 'mathematics'], 1, { health: 0.15, urban: 0.03 }),
  // ---- 古典
  t('geometry', '幾何学', 4, '科学', ['philosophy'], 1, { research: 0.2 }),
  t('engineering', '工学', 4, '道具', ['geometry', 'iron'], 1.1, { prod: 0.3 }),
  t('medicine', '医術', 4, '医療', ['philosophy'], 1, { health: 0.2 }),
  t('concrete', 'コンクリート', 4, '建築', ['masonry', 'engineering'], 1, { urban: 0.03, defense: 0.2 }),
  t('bureaucracy', '官僚制', 4, '統治', ['law', 'alphabet'], 1.1, { admin: 2 }),
  t('paper', '紙', 4, '記録', ['weaving', 'writing'], 0.9, { literacy: 0.1, research: 0.2 }),
  t('phalanx', '重装歩兵', 4, '軍事', ['iron_weapons', 'bureaucracy'], 1, { military: 0.6 }),
  t('crop_rotation', '輪作', 4, '農業', ['plow', 'iron'], 1, { food: 4 }),
  // ---- 中世
  t('watermill', '水車', 5, 'エネルギー', ['engineering'], 1, { prod: 0.4, energy: 0.2 }),
  t('windmill', '風車', 5, 'エネルギー', ['watermill'], 1, { prod: 0.2, energy: 0.2 }),
  t('heavy_plow', '重量有輪犂', 5, '農業', ['crop_rotation', 'husbandry'], 1, { food: 4 }),
  t('stirrup', '鐙と騎兵', 5, '軍事', ['husbandry', 'iron_weapons'], 1, { military: 0.6 }),
  t('castle', '城郭', 5, '軍事', ['concrete', 'engineering'], 1.1, { defense: 0.6 }),
  t('compass', '羅針盤', 5, '輸送', ['galley', 'geometry'], 1, { sail: 0.5, trade: 1 }),
  t('gunpowder', '火薬', 5, '軍事', ['medicine', 'iron'], 1.3, { military: 1 }),
  t('university', '大学', 5, '科学', ['paper', 'philosophy'], 1.2, { research: 0.5, literacy: 0.1 }),
  t('banking', '銀行', 5, '統治', ['coinage', 'paper'], 1, { trade: 1, prod: 0.1 }),
  t('printing', '活版印刷', 5, '記録', ['paper', 'engineering'], 1.3, { literacy: 0.3, research: 0.4 }),
  t('optics', '光学', 5, '科学', ['geometry', 'university'], 1, { research: 0.2 }),
  // ---- 近世
  t('navigation', '外洋航海', 6, '輸送', ['compass', 'optics'], 1.1, { sail: 1, trade: 2 }),
  t('cannon', '大砲', 6, '軍事', ['gunpowder', 'iron'], 1, { military: 1 }),
  t('telescope', '望遠鏡', 6, '科学', ['optics', 'astronomy'], 1, { research: 0.3, astro: 0.3 }),
  t('scientific_method', '科学的方法', 6, '科学', ['printing', 'telescope'], 1.3, { research: 0.8 }),
  t('physics', '力学', 6, '科学', ['scientific_method', 'geometry'], 1.2, { research: 0.4, prod: 0.1 }),
  t('chemistry', '化学', 6, '科学', ['scientific_method'], 1.1, { research: 0.3, prod: 0.1 }),
  t('blast_furnace', '高炉', 6, '冶金', ['iron', 'chemistry'], 1.1, { prod: 0.4, fossil: 0.2, energy: 0.3 }, DEP.coal),
  t('joint_stock', '株式会社', 6, '統治', ['banking', 'navigation'], 1, { trade: 2 }),
  t('inoculation', '種痘', 6, '医療', ['medicine', 'scientific_method'], 1, { health: 0.3 }),
  t('musket', 'マスケット銃', 6, '軍事', ['cannon'], 0.9, { military: 0.8 }),
  // ---- 産業
  t('steam', '蒸気機関', 7, 'エネルギー', ['physics', 'blast_furnace'], 1.4, { prod: 1, energy: 1.5, fossil: 0.6 }, DEP.coal),
  t('steel', '製鋼', 7, '冶金', ['blast_furnace', 'chemistry'], 1.1, { prod: 0.5, military: 0.5 }),
  t('railway', '鉄道', 7, '輸送', ['steam', 'steel'], 1.2, { trade: 3, admin: 1 }),
  t('factory', '工場制', 7, '道具', ['steam'], 1.2, { prod: 1, urban: 0.15, energy: 1 }),
  t('electricity', '電気', 7, 'エネルギー', ['physics', 'chemistry'], 1.3, { research: 0.3, energy: 1 }),
  t('telegraph', '電信', 7, '通信', ['electricity'], 1, { research: 0.3, admin: 2, trade: 1 }),
  t('sanitation', '上下水道', 7, '医療', ['aqueduct', 'chemistry'], 1, { health: 0.4, urban: 0.1 }),
  t('germ_theory', '細菌学', 7, '医療', ['chemistry', 'optics', 'sanitation'], 1.1, { health: 0.5 }),
  t('fertilizer', '化学肥料', 7, '農業', ['chemistry', 'steam'], 1.1, { food: 15 }),
  t('rifle', 'ライフル', 7, '軍事', ['musket', 'steel'], 1, { military: 1 }),
  // ---- 近代
  t('combustion', '内燃機関', 8, 'エネルギー', ['steel', 'electricity'], 1.3, { prod: 1, energy: 2, fossil: 0.8, trade: 2 }, DEP.oil),
  t('power_grid', '送電網', 8, 'エネルギー', ['electricity', 'steel'], 1.1, { prod: 0.8, energy: 1.5, urban: 0.1 }),
  t('automobile', '自動車', 8, '輸送', ['combustion'], 1.1, { trade: 2, urban: 0.05 }),
  t('aviation', '航空機', 8, '輸送', ['combustion', 'physics'], 1.2, { trade: 2, military: 1 }),
  t('radio', '無線通信', 8, '通信', ['telegraph', 'electricity'], 1, { research: 0.3, admin: 2, culture: 0.2 }),
  t('antibiotics', '抗生物質', 8, '医療', ['germ_theory', 'chemistry'], 1.2, { health: 0.6 }),
  t('assembly_line', '大量生産', 8, '道具', ['factory', 'power_grid'], 1.1, { prod: 1.5, urban: 0.1 }),
  t('nuclear_physics', '原子物理学', 8, '科学', ['electricity', 'scientific_method'], 1.4, { research: 0.5 }),
  t('tank', '機甲部隊', 8, '軍事', ['combustion', 'rifle'], 1, { military: 1.5 }),
  // ---- 情報
  t('nuclear_power', '原子力発電', 9, 'エネルギー', ['nuclear_physics', 'power_grid'], 1.3, { energy: 2, renew: 0.25 }, DEP.uranium),
  t('rocketry', 'ロケット', 9, '宇宙', ['combustion', 'nuclear_physics'], 1.3, { space: 1, military: 1 }),
  t('computer', '計算機', 9, '計算', ['electricity', 'nuclear_physics'], 1.4, { research: 1 }),
  t('semiconductor', '半導体', 9, '計算', ['computer', 'chemistry'], 1.2, { research: 1, prod: 0.5 }),
  t('satellite', '人工衛星', 9, '宇宙', ['rocketry', 'computer'], 1.1, { space: 1, research: 0.3, admin: 1 }),
  t('genetics', '遺伝学', 9, '医療', ['antibiotics', 'computer'], 1.2, { health: 0.4, research: 0.2 }),
  t('green_revolution', '緑の革命', 9, '農業', ['fertilizer', 'genetics'], 1.1, { food: 30 }),
  t('internet', 'インターネット', 9, '通信', ['semiconductor', 'satellite'], 1.3, { research: 1, trade: 2, culture: 0.3 }),
  t('vaccine', 'ワクチン', 9, '医療', ['genetics'], 1, { health: 0.6 }),
  t('solar_power', '太陽光発電', 9, 'エネルギー', ['semiconductor'], 1.2, { renew: 0.35, energy: 1 }),
  // ---- 宇宙
  t('spaceflight', '有人宇宙飛行', 10, '宇宙', ['satellite'], 1.2, { space: 1 }),
  t('space_station', '宇宙ステーション', 10, '宇宙', ['spaceflight'], 1.1, { space: 1, research: 0.3 }),
  t('ai', '人工知能', 10, '計算', ['internet', 'semiconductor'], 1.5, { research: 2, prod: 1 }),
  t('fusion', '核融合', 10, 'エネルギー', ['nuclear_power', 'ai'], 1.6, { energy: 3, renew: 0.6 }),
  t('lunar_base', '月面基地', 10, '宇宙', ['space_station'], 1.2, { space: 1 }),
  t('life_support', '閉鎖生態系', 10, '宇宙', ['genetics', 'space_station'], 1.1, { space: 1 }),
  t('interplanetary', '惑星間航行', 10, '宇宙', ['lunar_base', 'fusion'], 1.4, { space: 1 }),
  t('colonization', '他天体への入植', 10, '宇宙', ['interplanetary', 'life_support'], 1.3, { space: 1 }),
  t('terraforming', 'テラフォーミング', 10, '宇宙', ['colonization'], 1.5, { space: 1 }),
  t('starship', '恒星間船', 10, '宇宙', ['terraforming', 'ai'], 2, { space: 1 }),
  // ---- 魔法（ルールパックで有効なときだけ）
  t('mana_sense', '魔力感知', 0, '魔法', ['ritual'], 1, { magic: 0.3 }),
  t('incantation', '詠唱術', 1, '魔法', ['mana_sense', 'calendar'], 1, { magic: 0.5, health: 0.05 }),
  t('alchemy', '錬金術', 3, '魔法', ['incantation', 'copper'], 1, { magic: 0.4, prod: 0.1, health: 0.05 }),
  t('grimoire', '魔導書', 4, '魔法', ['incantation', 'paper'], 1, { magic: 0.6, research: 0.1 }),
  t('warding', '結界術', 4, '魔法', ['grimoire'], 1, { magic: 0.3, defense: 0.4 }),
  t('mana_mining', '魔晶採掘', 4, '魔法', ['alchemy', 'iron'], 1, { magic: 0.4, prod: 0.2 }, DEP.mana),
  t('astral_magic', '天体魔術', 5, '魔法', ['grimoire', 'astronomy'], 1.2, { magic: 0.8, astro: 0.5 }),
  t('golemcraft', 'ゴーレム工学', 5, '魔法', ['mana_mining', 'engineering'], 1.2, { magic: 0.5, prod: 0.5 }),
  t('levitation', '浮遊術', 6, '魔法', ['astral_magic'], 1.3, { magic: 0.5, trade: 1 }),
  t('arcane_engine', '魔導機関', 7, '魔法', ['golemcraft', 'physics'], 1.4, { magic: 1, prod: 1, energy: 1, renew: 0.2 }),
];
TECHS.forEach((x, i) => (x.index = i));
export const TECH: Record<string, Tech> = Object.fromEntries(TECHS.map((x) => [x.id, x]));
for (const x of TECHS) x.reqIdx = x.req.map((r) => {
  const p = TECH[r];
  if (!p) throw new Error(`tech ${x.id} requires unknown ${r}`);
  return p.index;
});
export const NT = TECHS.length;

export interface Building {
  id: string;
  name: string;
  tech: string | null;
  cost: number;
  fx: Fx;
  max: number;
  coastal?: boolean;
  river?: boolean;
  capital?: boolean;
  deposit?: number;
  /** Aligned with the sky (stone circles, star temples, orbital elevators). */
  mega?: boolean;
  /** Needs a religion in the settlement. */
  religious?: boolean;
  magic?: boolean;
  /** Burns fuel and emits CO2. */
  emits?: number;
  index: number;
  techIdx: number;
}

function b(id: string, name: string, tech: string | null, cost: number, fx: Fx, max: number, extra: Partial<Building> = {}): Building {
  return { id, name, tech, cost, fx, max, index: -1, techIdx: -1, ...extra };
}

export const BUILDINGS: Building[] = [
  b('shrine', '祭祀場', 'ritual', 8, { piety: 0.2, culture: 0.1 }, 1),
  b('granary', '穀物倉', 'pottery', 15, { food: 0.06, health: 0.03 }, 2),
  b('canal', '灌漑水路', 'irrigation', 30, { food: 0.1 }, 3, { river: true }),
  b('walls', '城壁', 'mudbrick', 40, { defense: 0.5 }, 1),
  b('market', '市場', 'wheel', 30, { trade: 0.3, prod: 0.05 }, 2),
  b('temple', '神殿', 'masonry', 60, { piety: 0.4, culture: 0.2 }, 2, { religious: true }),
  b('library', '図書館', 'writing', 50, { research: 0.3, literacy: 0.05 }, 2),
  b('smithy', '鍛冶場', 'copper', 35, { prod: 0.15, military: 0.1 }, 2),
  b('harbor', '港', 'sailing', 50, { trade: 0.4 }, 1, { coastal: true }),
  b('barracks', '兵舎', 'bronze', 40, { military: 0.3 }, 1),
  b('observatory', '天文台', 'astronomy', 60, { research: 0.2, astro: 1 }, 1),
  b('stone_circle', '環状列石', 'calendar', 80, { piety: 0.3, astro: 1 }, 1, { mega: true }),
  b('aqueduct', '水道橋', 'aqueduct', 90, { health: 0.15, urban: 0.03 }, 1),
  b('theatre', '劇場', 'philosophy', 70, { culture: 0.4 }, 1),
  b('palace', '宮殿', 'law', 150, { admin: 1, culture: 0.2 }, 1, { capital: true }),
  b('castle', '城', 'castle', 160, { defense: 1.2 }, 1),
  b('cathedral', '大聖堂', 'engineering', 220, { piety: 0.6, culture: 0.3 }, 1, { religious: true }),
  b('university_hall', '大学', 'university', 150, { research: 0.6, literacy: 0.1 }, 1),
  b('mill', '水車小屋', 'watermill', 40, { prod: 0.2, food: 0.04 }, 2, { river: true }),
  b('bank', '銀行', 'banking', 100, { trade: 0.3, prod: 0.05 }, 1),
  b('press', '印刷所', 'printing', 80, { research: 0.3, culture: 0.2, literacy: 0.1 }, 1),
  b('shipyard', '造船所', 'navigation', 120, { trade: 0.4, military: 0.2 }, 1, { coastal: true }),
  b('factory', '工場', 'factory', 200, { prod: 0.6 }, 4, { emits: 1 }),
  b('station', '鉄道駅', 'railway', 150, { trade: 0.5 }, 1),
  b('power_plant', '火力発電所', 'power_grid', 300, { prod: 0.4 }, 2, { emits: 2 }),
  b('hospital', '病院', 'germ_theory', 200, { health: 0.4 }, 2),
  b('skyscraper', '高層ビル', 'assembly_line', 400, { urban: 0.03, prod: 0.1 }, 8),
  b('laboratory', '研究所', 'computer', 400, { research: 1 }, 2),
  b('nuclear_plant', '原子力発電所', 'nuclear_power', 800, { prod: 0.6 }, 1),
  b('spaceport', '宇宙港', 'rocketry', 1500, { space: 1 }, 1),
  b('solar_farm', '太陽光発電所', 'solar_power', 400, { prod: 0.3, renew: 0.1 }, 2),
  b('fusion_plant', '核融合炉', 'fusion', 1500, { prod: 1, renew: 0.2 }, 1),
  b('space_elevator', '軌道エレベーター', 'terraforming', 8000, { space: 2, trade: 1 }, 1, { mega: true }),
  b('mage_tower', '魔導塔', 'grimoire', 120, { research: 0.2, mana: 0.5, magic: 0.3 }, 1, { magic: true }),
  b('golem_workshop', 'ゴーレム工房', 'golemcraft', 200, { prod: 0.4 }, 1, { magic: true }),
  b('mana_mine', '魔晶鉱山', 'mana_mining', 100, { prod: 0.1, mana: 0.3 }, 2, { magic: true, deposit: DEP.mana }),
  b('astral_temple', '星辰の神殿', 'astral_magic', 400, { piety: 0.4, astro: 2, magic: 0.5 }, 1, { magic: true, mega: true }),
];
BUILDINGS.forEach((x, i) => {
  x.index = i;
  x.techIdx = x.tech ? TECH[x.tech].index : -1;
});
export const NB = BUILDINGS.length;
export const BLD: Record<string, Building> = Object.fromEntries(BUILDINGS.map((x) => [x.id, x]));

export const GOVS = [
  { id: 'band', name: '部族', suffix: '族' },
  { id: 'chiefdom', name: '首長制', suffix: '首長国' },
  { id: 'kingdom', name: '王政', suffix: '王国' },
  { id: 'empire', name: '帝政', suffix: '帝国' },
  { id: 'theocracy', name: '神権政治', suffix: '神聖国' },
  { id: 'republic', name: '共和政', suffix: '共和国' },
  { id: 'democracy', name: '民主政', suffix: '民主国' },
  { id: 'federation', name: '連邦制', suffix: '連邦' },
] as const;
export const GOV = Object.fromEntries(GOVS.map((g, i) => [g.id, i])) as Record<(typeof GOVS)[number]['id'], number>;

/** Value axes of a culture (0..1). */
export const VALUES = ['好戦性', '商業重視', '信仰心', '伝統志向', '学問重視'] as const;
export const V = { aggression: 0, commerce: 1, piety: 2, tradition: 3, science: 4 } as const;

export const DEITIES = [
  { id: 'sky', name: '天体崇拝', word: '星辰' },
  { id: 'earth', name: '大地母神', word: '大地' },
  { id: 'ancestor', name: '祖霊信仰', word: '祖霊' },
  { id: 'doom', name: '終末信仰', word: '終末' },
  { id: 'one', name: '唯一神教', word: '唯一神' },
  { id: 'nature', name: '自然霊信仰', word: '森羅' },
  { id: 'fire', name: '火山神信仰', word: '炎' },
  { id: 'harvest', name: '豊穣神信仰', word: '豊穣' },
] as const;

export const DOCTRINES = [
  { name: '非暴力', dv: [-0.25, 0, 0.05, 0, 0] },
  { name: '聖戦', dv: [0.25, 0, 0.1, 0, 0] },
  { name: '禁欲', dv: [0, -0.2, 0.15, 0.05, 0] },
  { name: '勤労と商い', dv: [0, 0.2, 0, 0, 0.05] },
  { name: '学びの道', dv: [0, 0, 0, -0.05, 0.2] },
  { name: '祖先への敬い', dv: [0, 0, 0.05, 0.2, -0.05] },
  { name: '布教', dv: [0.05, 0, 0.15, 0, 0] },
] as const;

export const ROLE_NAMES = {
  ruler: '統治者', inventor: '発明家', prophet: '預言者', general: '将軍', explorer: '探検家', mage: '魔術師', merchant: '商人', player: 'あなた',
} as const;
export type Role = keyof typeof ROLE_NAMES;
