import { completionSummary } from './summary.js';
import { requireCubes } from './validation.js';
import { dimensions } from '../world/objects.js';
import type { TaskDefinition } from './types.js';
export const towerDefinition: TaskDefinition = {
  version: 1,
  mode: 'completion',
  kind: 'tower',
  summarize: completionSummary,
  validate(spec, scene) {
    if (spec.kind !== 'tower') throw new Error('Expected tower task');
    requireCubes(scene);
    if (!['any', 'size-ascending', 'size-descending'].includes(spec.order))
      throw new Error('Invalid tower order');
    if (
      scene.objects.reduce((sum, o) => sum + dimensions(o.shape)[1], 0) >
      scene.maxStackHeight + 1e-8
    )
      throw new Error('Unsupported tower height');
  },
  describe(spec, scene) {
    if (spec.kind !== 'tower') throw new Error('Expected tower task');
    const n = scene.objects.length;
    const mixedSizes = new Set(scene.objects.map((object) => dimensions(object.shape)[0])).size > 1;
    if (spec.language === 'zh')
      return `将全部 ${n} 个${mixedSizes ? '不同尺寸的' : '等大'}方块堆成一座塔。${spec.order === 'any' ? '上下顺序不限。' : `自下而上按尺寸${spec.order === 'size-ascending' ? '由小到大' : '由大到小'}排列，尺寸相同的方块顺序不限。`}`;
    return `Stack all ${n} ${mixedSizes ? 'differently sized' : 'equal-sized'} cubes into a single tower. ${spec.order === 'any' ? 'Any order is allowed.' : `Order them from ${spec.order === 'size-ascending' ? 'smallest to largest' : 'largest to smallest'} from bottom to top. Equal-sized cubes may appear in any order.`}`;
  },
  evaluate(sim, structures, spec) {
    if (spec.kind !== 'tower') throw new Error('Expected tower task');
    const sizes = sim.objects.map((o) => dimensions(o.shape)[0]);
    const expected = [...sizes].sort((a, b) => (spec.order === 'size-ascending' ? a - b : b - a));
    let completed = 0;
    for (const structure of structures) {
      if (!structure.tower) continue;
      let prefix = 0;
      for (const id of structure.tower) {
        if (spec.order !== 'any' && Math.abs(sizes[id] - expected[prefix]) > 1e-8) break;
        prefix++;
      }
      completed = Math.max(completed, prefix);
    }
    return {
      kind: spec.kind,
      success: completed === sim.objects.length,
      completed,
      total: sim.objects.length,
      groups: completed === sim.objects.length ? 1 : 0,
      totalGroups: 1,
      heightMeters: Math.max(0, ...structures.map((s) => s.height)),
    };
  },
};
