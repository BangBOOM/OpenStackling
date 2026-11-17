import { countDefinition } from './partition-count.js';
import { colorDefinition } from './partition-color.js';
import type { Simulation } from '../world/simulation.js';
import type { TaskDefinition, ResolvedTask, TaskEvaluation } from './types.js';
import type { TaskSpec } from './types.js';
import type { SceneSpec } from '../world/objects.js';
import { positive } from '../validation.js';
import { StructureTracker, type Structure } from './structures.js';
import { towerDefinition } from './tower.js';
import { heightDefinition } from './max-height.js';
const definitions = new Map<string, TaskDefinition>([
  [towerDefinition.kind, towerDefinition],
  [heightDefinition.kind, heightDefinition],
  [countDefinition.kind, countDefinition],
  [colorDefinition.kind, colorDefinition],
]);
export function registerTask(definition: TaskDefinition) {
  definitions.set(definition.kind, definition);
}
export function validateTask(spec: TaskSpec, scene: SceneSpec) {
  if (!['en', 'zh'].includes(spec.language)) throw new Error('Invalid prompt language');
  positive(spec.stableSeconds, 'stableSeconds');
  const definition = definitions.get(spec.kind);
  if (!definition) throw new Error('Invalid task kind');
  definition.validate(spec, scene);
}
export function resolveTask(config: {
  task: TaskSpec;
  scene: SceneSpec;
  run: { maxSeconds: number };
}): ResolvedTask {
  const spec = structuredClone(config.task),
    seconds = config.run.maxSeconds;
  const definition = definitions.get(spec.kind);
  if (!definition) throw new Error(`Task not registered: ${spec.kind}`);
  const common =
    definition.mode === 'deadline'
      ? ''
      : spec.language === 'zh'
        ? ` 请在 ${seconds} 秒模拟时间内完成。位置限有效桌面，每层一个方块。机械臂必须脱离所有目标塔，所有塔同时稳定 ${spec.stableSeconds} 秒；检查计入时限。`
        : ` Complete the task within ${seconds} simulated seconds. Towers may be placed anywhere on the valid tabletop, with one cube per level. The robot must release all target towers, and all towers must remain stable together for ${spec.stableSeconds} seconds within the time limit.`;
  return {
    version: definition.version,
    mode: definition.mode,
    spec,
    prompt: {
      templateId: spec.kind,
      templateVersion: definition.version,
      language: spec.language,
      text: definition.describe(spec, config.scene, seconds) + common,
    },
    controlSeconds: seconds,
    validationSeconds: definition.mode === 'deadline' ? spec.stableSeconds : 0,
  };
}
export class TaskScore {
  private tracker = new StructureTracker();
  structures: Structure[] = [];
  stableSeconds = 0;
  maximumStack = 0;
  evaluation: TaskEvaluation;
  readonly task: ResolvedTask;
  constructor(
    private sim: Simulation,
    task: ResolvedTask,
  ) {
    this.task = structuredClone(task);
    this.evaluation = {
      kind: task.spec.kind,
      success: false,
      completed: 0,
      total: sim.objects.length,
      groups: 0,
      totalGroups: 1,
      heightMeters: 0,
      stableSeconds: 0,
    };
  }
  get success() {
    return this.task.mode === 'completion' && this.evaluation.success;
  }
  get stable() {
    return this.evaluation.success;
  }
  beginValidation() {
    this.tracker.reset();
    this.stableSeconds = 0;
  }
  update() {
    this.structures = this.tracker.update(this.sim);
    const stable = this.structures.filter(
      (s) => s.stable && s.stableSeconds + 1e-9 >= this.task.spec.stableSeconds,
    );
    const definition = definitions.get(this.task.spec.kind)!;
    const instant = definition.evaluate(
      this.sim,
      this.structures.filter((s) => s.stable),
      this.task.spec,
    );
    this.stableSeconds = instant.success ? this.stableSeconds + this.sim.dt : 0;
    this.evaluation = {
      ...definition.evaluate(this.sim, stable, this.task.spec),
      stableSeconds: this.stableSeconds,
    };
    this.maximumStack = Math.max(0, ...stable.filter((s) => s.tower).map((s) => s.ids.length));
  }
}

export function summarizeTask(kind: TaskSpec['kind'], results: import('./types.js').TaskResult[]) {
  return definitions.get(kind)!.summarize(results);
}
