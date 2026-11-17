import { heightSummary } from './summary.js';
import type { TaskDefinition } from './types.js';
export const heightDefinition: TaskDefinition = {
  version: 1,
  mode: 'deadline',
  kind: 'max-height',
  summarize: heightSummary,
  validate() {},
  describe(spec, _scene, seconds) {
    return spec.language === 'zh'
      ? `在 ${seconds} 秒模拟时间内，使用任意数量的物体搭建尽可能高的稳定结构。允许改变朝向、桥接和共同支撑。截止后停止操作并检查 ${spec.stableSeconds} 秒。机械臂不得接触计分结构，只按检查结束时相对桌面的最高稳定高度计分，未使用物体不扣分。`
      : `Within ${seconds} simulated seconds, build the tallest stable structure using any subset of the objects. Reorientation, bridging, and shared supports are allowed. Control stops at the deadline, followed by a ${spec.stableSeconds}-second stability check. The robot must not touch the scored structure. Only its final stable height above the tabletop counts; unused objects carry no penalty.`;
  },
  evaluate(_sim, structures, spec) {
    return {
      kind: spec.kind,
      success: false,
      completed: 0,
      total: 0,
      groups: 0,
      totalGroups: 0,
      heightMeters: Math.max(0, ...structures.map((s) => s.height)),
    };
  },
};
