import { completionSummary } from './summary.js';
import { integer } from '../validation.js';
import { partitionSize } from './validation.js';
import type { TaskDefinition } from './types.js';

export const countDefinition: TaskDefinition = {
  version: 1,
  mode: 'completion',
  kind: 'partition-count',
  summarize: completionSummary,
  validate(spec, scene) {
    if (spec.kind !== 'partition-count') throw new Error('Expected count partition task');
    const size = partitionSize(scene);
    spec.counts.forEach((v) => integer(v, 'tower count'));
    if (spec.counts.reduce((a, b) => a + b, 0) !== scene.objects.length)
      throw new Error('Tower counts must use every object');
    if (Math.max(...spec.counts) * size > scene.maxStackHeight + 1e-8)
      throw new Error('Unsupported tower height');
  },
  describe(spec, scene) {
    if (spec.kind !== 'partition-count') throw new Error('Expected count partition task');
    const counts = spec.counts.join(', ');
    return spec.language === 'zh'
      ? `将全部 ${scene.objects.length} 个方块分成 ${spec.counts.length} 座独立的塔，各座塔的层数分别为 [${counts}]。颜色不限，各座塔的位置和排列顺序不限。`
      : `Use all ${scene.objects.length} cubes to build ${spec.counts.length} separate towers with heights of [${counts}] cubes. Colors, tower positions, and tower order do not matter.`;
  },
  evaluate(sim, structures, spec) {
    if (spec.kind !== 'partition-count') throw new Error('Expected count partition task');
    const slots = new Map<number, number>();
    for (const count of spec.counts) slots.set(count, (slots.get(count) ?? 0) + 1);
    let completed = 0;
    let groups = 0;
    for (const structure of structures) {
      if (!structure.tower) continue;
      const count = structure.tower.length;
      const available = slots.get(count) ?? 0;
      if (available === 0) continue;
      slots.set(count, available - 1);
      completed += count;
      groups++;
    }
    return {
      kind: spec.kind,
      success: groups === spec.counts.length && completed === sim.objects.length,
      completed,
      total: sim.objects.length,
      groups,
      totalGroups: spec.counts.length,
      heightMeters: Math.max(0, ...structures.map((structure) => structure.height)),
    };
  },
};
