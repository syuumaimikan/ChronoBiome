import type { RulePackInput } from '../schema';
import { earthLikePack } from './earthLike';

/**
 * "Earth-like + Arcane": the same calibrated nature, plus magic as one more
 * law of the world. Mana wells up along plate boundaries, volcanoes and old
 * forests; civilisations research spell parts like any technology, build mage
 * towers and golems, and planetary alignments change how much mana flows.
 */
export const arcanePack: RulePackInput = {
  ...structuredClone(earthLikePack),
  meta: {
    name: 'Earth-like + Arcane',
    description: '地球の経験則に、魔法と秘術としての占星術を加えたルール',
  },
  magic: {
    enabled: true,
    elements: ['火', '水', '地', '風', '生命', '精神', '時空'],
    sourceRate: 0.02,
    decayPerYear: 0.01,
    potency: 1,
  },
  astrology: {
    enabled: true,
    arcane: true,
    orbDeg: 6,
  },
};

export const RULE_PACKS: { id: string; name: string; pack: RulePackInput }[] = [
  { id: 'earth', name: 'Earth-like（魔法なし）', pack: earthLikePack },
  { id: 'arcane', name: 'Earth-like + Arcane（魔法あり）', pack: arcanePack },
];
