/** Catastrophes (and blessings) the Lab can inject; kept apart so the UI can list them without the simulation. */
export type ScenarioKind = 'impact' | 'supervolcano' | 'pandemic' | 'solar_flare' | 'ice_age' | 'golden_age' | 'red_giant';

export const SCENARIOS: { id: ScenarioKind; name: string; text: string }[] = [
  { id: 'impact', name: '巨大隕石', text: '白亜紀末級（直径 10 km 超）の小惑星が衝突する' },
  { id: 'supervolcano', name: '超巨大噴火', text: '火山の冬と CO2 の放出、周辺の町の壊滅' },
  { id: 'pandemic', name: '大疫病', text: '感染力と致死率の高い新しい病が最大の都市から広がる' },
  { id: 'solar_flare', name: '巨大太陽嵐', text: '電力と通信の網が焼け、近代文明が打撃を受ける' },
  { id: 'ice_age', name: '急な氷期', text: '温室効果ガスが急減し、氷床が広がる' },
  { id: 'golden_age', name: '黄金時代', text: '豊作と学問の隆盛（研究と食料が一時的に増える）' },
  { id: 'red_giant', name: '恒星の膨張', text: '主星が赤色巨星への道を歩み始める。宇宙進出は間に合うか' },
];
