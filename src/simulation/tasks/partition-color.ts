import { completionSummary } from './summary.js';
import { partitionSize } from './validation.js';
import type { TaskDefinition } from './types.js';

export const colorDefinition: TaskDefinition = {
  version: 1,
  mode: 'completion',
  kind: 'partition-color',
  summarize: completionSummary,
  validate(_spec, scene) {
    const size = partitionSize(scene);
    const counts = Object.values(
      scene.objects.reduce<Record<string, number>>((m, o) => {
        m[o.color] = (m[o.color] ?? 0) + 1;
        return m;
      }, {}),
    );
    if (Math.max(...counts) * size > scene.maxStackHeight + 1e-8)
      throw new Error('Unsupported tower height');
  },
  describe(spec, scene) {
    if (spec.kind !== 'partition-color') throw new Error('Expected color partition task');
    return spec.language === 'zh'
      ? `将全部 ${scene.objects.length} 个方块按颜色分堆。每种颜色恰好形成一座塔，同色方块必须全部放在一起，不同颜色不能混堆。各座塔的位置不限。`
      : `Group all ${scene.objects.length} cubes by color. Build exactly one tower for each color, using every cube of that color and no cubes of other colors. Tower positions do not matter.`;
  },
  evaluate(sim, structures, spec) {
    if (spec.kind !== 'partition-color') throw new Error('Expected color partition task');
    const counts = new Map<string, number>();
    for (const object of sim.objects) counts.set(object.color, (counts.get(object.color) ?? 0) + 1);
    let completed = 0;
    const matched = new Set<string>();
    for (const structure of structures) {
      if (!structure.tower) continue;
      const color = sim.objects[structure.tower[0]].color;
      if (
        matched.has(color) ||
        structure.tower.length !== counts.get(color) ||
        structure.tower.some((id) => sim.objects[id].color !== color)
      )
        continue;
      matched.add(color);
      completed += structure.tower.length;
    }
    return {
      kind: spec.kind,
      success: matched.size === counts.size && completed === sim.objects.length,
      completed,
      total: sim.objects.length,
      groups: matched.size,
      totalGroups: counts.size,
      heightMeters: Math.max(0, ...structures.map((structure) => structure.height)),
    };
  },
};
