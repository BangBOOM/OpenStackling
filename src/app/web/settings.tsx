import { taskPreset, randomScenePatch } from '../../runtime/presets';
import { resolveTask } from '../../simulation/tasks/registry';
import { cubeObjects, dimensions } from '../../simulation/world/objects';
import { useTranslation } from 'react-i18next';
import { ErrorText } from './errors';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import { Switch } from './components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group';
import { Separator } from './components/ui/separator';
import type { Config } from '../../runtime/config';
import type { CameraMount } from '../../simulation/sensors/config';
import { permissions, useUI } from './store';
import type { Runtime } from './runtime';
const ReadOnly = createContext(false);
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        disabled={useContext(ReadOnly)}
        type="number"
        value={Number.isNaN(value) ? '' : value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
    </div>
  );
}
function ListField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number[];
  onChange: (values: number[]) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        disabled={useContext(ReadOnly)}
        key={value.join(',')}
        defaultValue={value.join(', ')}
        onBlur={(event) => onChange(event.target.value.split(',').map((v) => Number(v.trim())))}
      />
    </div>
  );
}
function Fields({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4">{children}</div>;
}
function JointTable({ state, target }: ReturnType<typeof useUI.getState>['telemetry']) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-right text-xs tabular-nums">
      <thead className="text-muted-foreground">
        <tr>
          <th className="pb-3 text-left font-normal">{t('ui.joint')}</th>
          <th className="pb-3 font-normal">{t('ui.measured')}</th>
          <th className="pb-3 font-normal">{t('ui.target')}</th>
        </tr>
      </thead>
      <tbody>
        {state.map((v, i) => {
          const joint = (i - 2) % 7;
          const gap = i === 8 || i === 15;
          const scale = gap ? 1000 : 180 / Math.PI,
            unit = gap ? ' mm' : '°';
          const label =
            i < 2
              ? t(i === 0 ? 'ui.waistYaw' : 'ui.waistPitch')
              : [t(i < 9 ? 'ui.leftArm' : 'ui.rightArm'), gap ? t('ui.gripper') : `q${joint + 1}`]
                  .filter(Boolean)
                  .join(' · ');
          return (
            <tr key={i} className="h-8 border-t">
              <td className="text-left">{label}</td>
              <td>
                {(v * scale).toFixed(1)}
                {unit}
              </td>
              <td>
                {(target[i] * scale).toFixed(1)}
                {unit}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
export function Settings({
  runtime,
  readOnly = false,
  state,
}: {
  runtime: Runtime | null;
  readOnly?: boolean;
  state: ReturnType<typeof useUI.getState>;
}) {
  const { t, i18n } = useTranslation();
  const draft = readOnly ? state.config : state.draft,
    error = state.draftError,
    { markers, annotations } = state;
  const seedEditable =
    !readOnly ||
    (state.policyStatus === 'bound' &&
      permissions(state.mode, state.telemetry.teacher, state.policyStatus).shuffle);
  const seedDirty = state.draftSceneSeed !== state.sceneSeed;
  function change<K extends keyof Config, P extends keyof Config[K]>(
    section: K,
    key: P,
    value: Config[K][P],
  ) {
    if (readOnly) return;
    runtime?.updateDraft({ [section]: { [key]: value } });
  }
  if (!draft) return null;
  const preset = taskPreset(draft);
  const bound = state.policyStatus === 'bound';
  const fieldsLocked = readOnly;
  const coreLocked = readOnly || bound;
  const head = draft.camera.head;
  const headMounted = draft.camera.mount === 'head';
  const setHead = (key: keyof typeof head, value: number) =>
    runtime?.updateDraft({ camera: { head: { ...head, [key]: value } } });
  const size = dimensions(draft.scene.objects[0].shape)[0];
  const listChange = (values: number[], apply: () => void) => {
    if (!values.length || values.some((v) => !Number.isFinite(v) || v <= 0)) {
      useUI.setState({ draftError: t('error.nonFinite') });
      return;
    }
    apply();
  };
  return (
    <ReadOnly.Provider value={fieldsLocked}>
      <form
        data-settings
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) runtime?.applyEdit();
          else runtime?.applySceneSeed();
        }}
      >
        <Tabs defaultValue="environment" className="min-h-0 flex-1 gap-0">
          <div className="px-5 pb-4">
            <TabsList className="w-full">
              <TabsTrigger value="environment">{t('ui.environment')}</TabsTrigger>
              <TabsTrigger value="camera">{t('ui.camera')}</TabsTrigger>
              <TabsTrigger value="run">{t('ui.execution')}</TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            <TabsContent value="environment" className="space-y-5">
              <dl className="flex justify-between text-sm">
                <dt className="text-muted-foreground">{t('ui.theme')}</dt>
                <dd data-current-theme>{t(`theme.${state.config.appearance.theme}`)}</dd>
              </dl>
              <div className="space-y-2">
                <Label htmlFor="scene-seed">{t('ui.seed')}</Label>
                <Input
                  id="scene-seed"
                  type="number"
                  min={0}
                  max={4294967295}
                  step={1}
                  placeholder={t('ui.randomSeed')}
                  disabled={!seedEditable}
                  value={
                    state.draftSceneSeed === null || Number.isNaN(state.draftSceneSeed)
                      ? ''
                      : state.draftSceneSeed
                  }
                  onChange={(e) =>
                    runtime?.updateSceneSeed(
                      e.target.validity.badInput
                        ? NaN
                        : e.target.value === ''
                          ? null
                          : Number(e.target.value),
                    )
                  }
                />
                <dl className="flex justify-between text-sm text-muted-foreground">
                  <dt>{t('ui.currentSeed')}</dt>
                  <dd className="font-mono tabular-nums" data-scene-seed>
                    {state.config.run.seed}
                  </dd>
                </dl>
              </div>
              <dl className="flex justify-between text-sm">
                <dt className="text-muted-foreground">{t('ui.task')}</dt>
                <dd>{t(`task.${preset}`)}</dd>
              </dl>
              {(preset === 'stack-all' ||
                preset === 'partition-count' ||
                preset === 'partition-color') && (
                <Fields>
                  <NumberField
                    label={t('ui.blockCount')}
                    value={draft.scene.objects.length}
                    min={2}
                    max={12}
                    onChange={(value) => {
                      if (!Number.isInteger(value) || value < 1) {
                        useUI.setState({ draftError: t('error.nonFinite') });
                        return;
                      }
                      runtime?.updateDraft({
                        scene: { objects: cubeObjects(value, size) },
                        run: { maxSeconds: preset === 'stack-all' ? (value > 2 ? 240 : 120) : 480 },
                      });
                    }}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="block-size">{t('ui.blockSize')}</Label>
                    <Select
                      disabled={fieldsLocked}
                      value={String(size)}
                      onValueChange={(value) =>
                        runtime?.updateDraft({
                          scene: {
                            objects: draft.scene.objects.map((o) => ({
                              ...o,
                              shape: {
                                kind: 'cuboid',
                                size: [Number(value), Number(value), Number(value)],
                              },
                            })),
                          },
                        })
                      }
                    >
                      <SelectTrigger id="block-size" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[0.035, 0.05, 0.075].map((value) => (
                          <SelectItem key={value} value={String(value)}>
                            {Number((value * 100).toFixed(1))} cm
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </Fields>
              )}
              {draft.task.kind === 'partition-count' && (
                <ListField
                  label={t('ui.towerCounts')}
                  value={draft.task.counts}
                  onChange={(counts) =>
                    listChange(counts, () => {
                      if (counts.some((n) => !Number.isInteger(n))) {
                        useUI.setState({ draftError: t('error.nonFinite') });
                        return;
                      }
                      runtime?.updateDraft({
                        task: { kind: 'partition-count', counts },
                        scene: {
                          objects: cubeObjects(
                            counts.reduce((a, b) => a + b, 0),
                            size,
                          ),
                        },
                      });
                    })
                  }
                />
              )}
              {draft.task.kind === 'partition-color' && (
                <ListField
                  label={t('ui.colorCounts')}
                  value={Object.values(
                    draft.scene.objects.reduce<Record<string, number>>((counts, o) => {
                      counts[o.color] = (counts[o.color] ?? 0) + 1;
                      return counts;
                    }, {}),
                  )}
                  onChange={(counts) =>
                    listChange(counts, () => {
                      if (counts.some((n) => !Number.isInteger(n)) || counts.length > 6) {
                        useUI.setState({ draftError: t('error.nonFinite') });
                        return;
                      }
                      runtime?.updateDraft({
                        scene: {
                          objects: cubeObjects(
                            counts.reduce((a, b) => a + b, 0),
                            size,
                            counts,
                          ),
                        },
                      });
                    })
                  }
                />
              )}
              {(preset === 'stack-sized' || preset === 'stack-ordered') && (
                <NumberField
                  label={t('ui.blockCount')}
                  value={draft.scene.objects.length}
                  min={2}
                  max={12}
                  onChange={(count) => {
                    if (!Number.isInteger(count) || count < 2 || count > 12) {
                      useUI.setState({ draftError: t('error.nonFinite') });
                      return;
                    }
                    runtime?.updateDraft(randomScenePatch(draft, draft.run.seed, count));
                  }}
                />
              )}
              {preset === 'max-height' && (
                <NumberField
                  label={t('ui.objectCount')}
                  value={draft.scene.objects.length}
                  min={1}
                  max={12}
                  onChange={(count) => {
                    if (!Number.isInteger(count) || count < 1 || count > 12) {
                      useUI.setState({ draftError: t('error.nonFinite') });
                      return;
                    }
                    runtime?.updateDraft(randomScenePatch(draft, draft.run.seed, count));
                  }}
                />
              )}
              {preset === 'stack-ordered' && draft.task.kind === 'tower' && (
                <div className="space-y-2">
                  <Label htmlFor="task-order">{t('ui.order')}</Label>
                  <Select
                    disabled={fieldsLocked}
                    value={draft.task.order}
                    onValueChange={(value) =>
                      runtime?.updateDraft({
                        task: {
                          kind: 'tower',
                          order: value as 'size-ascending' | 'size-descending',
                        },
                      })
                    }
                  >
                    <SelectTrigger id="task-order" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['size-ascending', 'size-descending'].map((order) => (
                        <SelectItem key={order} value={order}>
                          {t(`task.${order}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label>{t('ui.taskPrompt')}</Label>
                <p data-task-prompt className="text-sm leading-relaxed">
                  {
                    resolveTask(
                      readOnly
                        ? draft
                        : {
                            ...draft,
                            task: {
                              ...draft.task,
                              language: i18n.resolvedLanguage === 'zh' ? 'zh' : 'en',
                            },
                          },
                    ).prompt.text
                  }
                </p>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <Label htmlFor="joint-markers">{t('ui.markers')}</Label>
                <Switch
                  disabled={fieldsLocked}
                  id="joint-markers"
                  checked={markers}
                  onCheckedChange={(markers) => useUI.setState({ markers })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="joint-annotations">{t('ui.annotations')}</Label>
                <Switch
                  disabled={fieldsLocked}
                  id="joint-annotations"
                  checked={annotations}
                  onCheckedChange={(annotations) => useUI.setState({ annotations })}
                />
              </div>
            </TabsContent>
            <TabsContent value="camera" className="space-y-5">
              <div className="space-y-2">
                <Label>{t('ui.viewport')}</Label>
                <ToggleGroup
                  type="single"
                  value={state.viewport}
                  aria-label={t('ui.viewport')}
                  onValueChange={(v) => {
                    if (v) runtime?.setViewport(v as 'orbit' | 'head');
                  }}
                  variant="outline"
                  spacing={2}
                  className="w-full"
                >
                  <ToggleGroupItem value="orbit" className="flex-1">
                    {t('ui.overview')}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="head" className="flex-1">
                    {t('ui.firstPerson')}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <Separator />
              <ReadOnly.Provider value={coreLocked}>
                <div className="space-y-2">
                  <Label htmlFor="camera-mount">{t('ui.captureCamera')}</Label>
                  <Select
                    value={draft.camera.mount}
                    disabled={coreLocked}
                    onValueChange={(v) => change('camera', 'mount', v as CameraMount)}
                  >
                    <SelectTrigger id="camera-mount" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="external">{t('ui.externalCamera')}</SelectItem>
                      <SelectItem value="head">{t('ui.headCamera')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {!headMounted && (
                  <>
                    <div className="space-y-2">
                      <Label>{t('ui.position')}</Label>
                      <ToggleGroup
                        disabled={coreLocked}
                        type="single"
                        value={draft.camera.position}
                        onValueChange={(v) => {
                          if (v) change('camera', 'position', v);
                        }}
                        variant="outline"
                        spacing={2}
                        className="grid w-full grid-cols-3"
                        aria-label={t('ui.cameraPosition')}
                      >
                        {['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'].map((position) =>
                          position ? (
                            <ToggleGroupItem
                              className="h-10 w-full data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                              value={position}
                              key={position}
                              data-camera={position}
                              aria-label={t(`direction.${position}`)}
                            >
                              {t(`direction.${position}`)}
                            </ToggleGroupItem>
                          ) : (
                            <span
                              key="table"
                              className="flex h-10 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground"
                              aria-hidden="true"
                            >
                              {t('ui.table')}
                            </span>
                          ),
                        )}
                      </ToggleGroup>
                    </div>
                    <Fields>
                      <NumberField
                        label={t('ui.distance')}
                        value={draft.camera.distance}
                        onChange={(v) => change('camera', 'distance', v)}
                        min={0.1}
                        step={0.05}
                      />
                      <NumberField
                        label={t('ui.height')}
                        value={draft.camera.height}
                        onChange={(v) => change('camera', 'height', v)}
                        min={0.1}
                        step={0.05}
                      />
                    </Fields>
                  </>
                )}
                {headMounted && (
                  <NumberField
                    label={t('ui.headPitch')}
                    value={head.pitch}
                    onChange={(v) => setHead('pitch', v)}
                    min={40}
                    max={70}
                  />
                )}
                <NumberField
                  label={t('ui.fov')}
                  value={headMounted ? head.fov : draft.camera.fov}
                  onChange={(v) => (headMounted ? setHead('fov', v) : change('camera', 'fov', v))}
                  min={headMounted ? 40 : 1}
                  max={headMounted ? 100 : 149}
                />
                {!headMounted && (
                  <div className="grid grid-cols-3 gap-2">
                    {['X', 'Y', 'Z'].map((axis, i) => (
                      <NumberField
                        key={axis}
                        label={t('ui.lookAt', { axis })}
                        value={draft.camera.target[i]}
                        step={0.05}
                        onChange={(v) => {
                          const target = [...draft.camera.target];
                          target[i] = v;
                          change('camera', 'target', target);
                        }}
                      />
                    ))}
                  </div>
                )}
                <Fields>
                  <NumberField
                    label={t('ui.width')}
                    value={draft.camera.width}
                    onChange={(v) => change('camera', 'width', v)}
                    min={1}
                    max={4096}
                  />
                  <NumberField
                    label={t('ui.heightPixels')}
                    value={draft.camera.heightPixels}
                    onChange={(v) => change('camera', 'heightPixels', v)}
                    min={1}
                    max={4096}
                  />
                </Fields>
                <div className="flex items-center justify-between">
                  <Label htmlFor="depth-enabled">{t('ui.depthCapture')}</Label>
                  <Switch
                    disabled={coreLocked}
                    id="depth-enabled"
                    checked={draft.camera.depth}
                    onCheckedChange={(v) => change('camera', 'depth', v)}
                  />
                </div>
              </ReadOnly.Provider>
            </TabsContent>
            <TabsContent value="run" className="space-y-5">
              <ReadOnly.Provider value={coreLocked}>
                <NumberField
                  label={t('ui.physicsHz')}
                  value={draft.environment.physicsHz}
                  onChange={(v) => change('environment', 'physicsHz', v)}
                  min={1}
                />
                <Fields>
                  <NumberField
                    label={t('ui.controlHz')}
                    value={draft.run.controlHz}
                    onChange={(v) => change('run', 'controlHz', v)}
                    min={1}
                  />
                  <NumberField
                    label={t('ui.observationHz')}
                    value={draft.run.observationHz}
                    onChange={(v) => change('run', 'observationHz', v)}
                    min={1}
                  />
                </Fields>
              </ReadOnly.Provider>
              <NumberField
                label={t('ui.maxSeconds')}
                value={draft.run.maxSeconds}
                onChange={(v) => change('run', 'maxSeconds', v)}
                min={1}
              />
              <Separator />
              <JointTable {...state.telemetry} />
            </TabsContent>
          </div>
        </Tabs>
        {(!readOnly || (seedEditable && seedDirty)) && (
          <div className="space-y-3 border-t p-5">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                <ErrorText value={error} />
              </p>
            )}
            <div className="flex gap-2 [&_button]:px-3 [&_button]:text-xs">
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!runtime}
                  onClick={() => runtime?.restoreDefaults()}
                >
                  {t('ui.defaults')}
                </Button>
              )}
              <Button type="submit" className="flex-1" disabled={!runtime || !!error}>
                {t('ui.apply')}
              </Button>
            </div>
          </div>
        )}
      </form>
    </ReadOnly.Provider>
  );
}
