import './i18n';
import { appearanceIdentity, sameAppearance } from '../../runtime/appearance';
import { THEME_IDS } from '../../runtime/theme-catalog';
import { useTranslation } from 'react-i18next';
import { ErrorText } from './errors';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Camera,
  Play,
  Pause,
  Layers2,
  Square,
  RotateCcw,
  Shuffle,
  SlidersHorizontal,
  Keyboard,
  Plug,
  X,
} from 'lucide-react';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Button } from './components/ui/button';
import { Separator } from './components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from './components/ui/sheet';
import { Runtime } from './runtime';
import { useUI, permissions, TEACHER_RATES } from './store';
import { TASK_PRESETS, taskPreset, type TaskPreset } from '../../runtime/presets';
import { Settings } from './settings';
import { SensorPreview } from './preview';
import { Compass } from './compass';
import './style.css';
function IconButton({
  label,
  onClick,
  children,
  pressed,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant={pressed ? 'secondary' : 'ghost'}
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
const floatingCard =
  'top-16 right-3 bottom-auto w-[min(360px,calc(100vw-24px))] gap-0 overflow-hidden rounded-xl border shadow-md sm:top-[72px] sm:right-5 sm:w-[336px]';

function onPanelCloseAutoFocus(event: Event) {
  const state = useUI.getState();
  // When switching cards, let the newly opened card own focus.
  if (state.policyOpen || state.shortcutsOpen || state.settingsViewOpen || state.mode === 'editing')
    event.preventDefault();
}

function Help({ runtime }: { runtime: Runtime | null }) {
  const { t } = useTranslation();
  const open = useUI((s) => s.shortcutsOpen);
  const anotherOpen = useUI((s) => s.policyOpen || s.settingsViewOpen || s.mode === 'editing');
  return (
    <Sheet
      open={open}
      modal={false}
      onOpenChange={(open) => {
        if (open && runtime?.mode === 'editing') runtime.cancelEdit();
        useUI.setState({
          shortcutsOpen: open,
          ...(open ? { policyOpen: false, settingsViewOpen: false } : {}),
        });
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              variant={open ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={t('ui.shortcuts')}
            >
              <Keyboard />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('ui.shortcuts')}</TooltipContent>
      </Tooltip>
      {!anotherOpen && (
        <SheetContent
          variant="floating"
          onCloseAutoFocus={onPanelCloseAutoFocus}
          aria-describedby={undefined}
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          className={`${floatingCard} h-auto max-h-[calc(100dvh-76px)] sm:max-h-[calc(100dvh-92px)]`}
        >
          <SheetHeader className="h-14 shrink-0 flex-row items-center justify-between px-5 py-0">
            <SheetTitle className="text-sm font-medium">{t('ui.shortcuts')}</SheetTitle>
            <SheetClose asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t('ui.close')}>
                <X />
              </Button>
            </SheetClose>
          </SheetHeader>
          <dl className="space-y-4 overflow-y-auto px-5 pb-5 text-sm">
            {[
              [t('ui.forwardBack'), 'W / S'],
              [t('ui.leftRight'), 'A / D'],
              [t('ui.upDown'), 'U / J'],
              [t('ui.grip'), 'H / K'],
              [t('ui.orbit'), t('ui.drag')],
              [t('ui.zoom'), t('ui.scroll')],
              [t('ui.jointAxes'), t('ui.clickArm')],
            ].map(([name, key]) => (
              <div key={name} className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="shrink-0 font-mono text-xs">{key}</dd>
              </div>
            ))}
          </dl>
        </SheetContent>
      )}
    </Sheet>
  );
}
function PolicyPanel({ runtime }: { runtime: Runtime | null }) {
  const { t } = useTranslation();
  const {
    policyOpen,
    policyStatus,
    policyManifest,
    config,
    policyDiff,
    mode,
    shortcutsOpen,
    settingsViewOpen,
  } = useUI();
  const anotherOpen = shortcutsOpen || settingsViewOpen || mode === 'editing';
  const [url, setUrl] = useState('ws://127.0.0.1:8000/policy');
  const [token, setToken] = useState('');
  const idle = mode === 'idle' || mode === 'finished';
  const busy = ['connecting', 'binding', 'draining'].includes(policyStatus);
  return (
    <Sheet
      open={policyOpen}
      modal={false}
      onOpenChange={(open) => {
        if (open && runtime?.mode === 'editing') runtime.cancelEdit();
        useUI.setState({
          policyOpen: open,
          ...(open ? { shortcutsOpen: false, settingsViewOpen: false } : {}),
        });
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              id="policy"
              size="icon-sm"
              variant={policyOpen ? 'secondary' : 'ghost'}
              aria-label={t('policy.title')}
            >
              <Plug />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('policy.title')}</TooltipContent>
      </Tooltip>
      {!anotherOpen && (
        <SheetContent
          variant="floating"
          onCloseAutoFocus={onPanelCloseAutoFocus}
          aria-describedby={undefined}
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          className={`${floatingCard} h-auto max-h-[calc(100dvh-92px)]`}
        >
          <SheetHeader className="h-14 shrink-0 flex-row items-center justify-between px-5 py-0">
            <SheetTitle className="text-sm font-medium">{t('policy.title')}</SheetTitle>
            <SheetClose asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t('ui.close')}>
                <X />
              </Button>
            </SheetClose>
          </SheetHeader>
          <div className="space-y-4 overflow-y-auto px-5 pb-5" data-policy-panel>
            <div className="text-sm text-muted-foreground" data-policy-status>
              {t(`policy.state.${policyStatus}`)}
            </div>
            <div className="space-y-2">
              <Label htmlFor="policy-url">{t('policy.address')}</Label>
              <Input
                id="policy-url"
                value={url}
                disabled={policyStatus !== 'disconnected'}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            {policyStatus === 'disconnected' && (
              <div className="space-y-2">
                <Label htmlFor="policy-token">{t('policy.token')}</Label>
                <Input
                  id="policy-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
            )}
            {policyManifest && (
              <dl className="space-y-2 text-sm">
                {[
                  [t('policy.model'), policyManifest.policyId],
                  [t('policy.revision'), policyManifest.modelRevision],
                  [t('policy.profile'), policyManifest.profile.profileId],
                  [
                    t('policy.trainingTheme'),
                    t(`theme.${policyManifest.profile.trainingAppearance.id}`, {
                      defaultValue: policyManifest.profile.trainingAppearance.id,
                    }),
                  ],
                  [t('policy.actualTheme'), t(`theme.${config.appearance.theme}`)],
                  [
                    t('policy.appearance'),
                    t(
                      sameAppearance(
                        policyManifest.profile.trainingAppearance,
                        appearanceIdentity(config.appearance.theme),
                      )
                        ? 'policy.appearanceMatched'
                        : 'policy.appearanceShifted',
                    ),
                  ],
                  [
                    t('policy.environment'),
                    t(
                      policyManifest.profile.environmentFingerprint === __STACKLING_ENVIRONMENT__
                        ? 'policy.environmentMatched'
                        : 'policy.environmentDiffers',
                    ),
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="break-all text-right">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {policyStatus === 'review' && (
              <div className="space-y-2 text-sm" data-policy-diff>
                {policyDiff.length === 0 ? (
                  <p>{t('policy.noChanges')}</p>
                ) : (
                  policyDiff.map((d) => (
                    <div key={d.path} className="border-b pb-2">
                      <div className="break-all text-muted-foreground">
                        {t(`field.${d.path.split('.').at(-1)}`, { defaultValue: d.path })}
                      </div>
                      <div className="break-all font-mono text-xs">
                        {JSON.stringify(d.before)} → {JSON.stringify(d.after)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
            {['bound', 'fault'].includes(policyStatus) && (
              <Button
                id="policy-config"
                variant="outline"
                size="sm"
                onClick={() => runtime?.openSettings()}
              >
                {t('policy.viewConfig')}
              </Button>
            )}
            <div className="flex flex-wrap gap-2">
              {policyStatus === 'disconnected' && (
                <Button
                  id="policy-connect"
                  size="sm"
                  disabled={!idle}
                  onClick={() => void runtime?.connectPolicy({ url, token })}
                >
                  {t('policy.connect')}
                </Button>
              )}
              {policyStatus === 'review' && (
                <Button id="policy-bind" size="sm" onClick={() => void runtime?.bindPolicy()}>
                  {t('policy.bind')}
                </Button>
              )}
              {policyStatus !== 'disconnected' && (
                <Button
                  id="policy-disconnect"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setToken('');
                    void runtime?.disconnectPolicy();
                  }}
                >
                  {t('policy.disconnect')}
                </Button>
              )}
            </div>
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}
function RunStatus() {
  const { t } = useTranslation();
  const telemetry = useUI((s) => s.telemetry),
    mode = useUI((s) => s.mode);
  const status =
    mode === 'running' && telemetry.teacher
      ? t(`phase.${telemetry.phase}`)
      : t(`status.${telemetry.status}`);
  return (
    <div
      data-run-status
      className="pointer-events-none absolute right-5 bottom-5 flex max-w-sm items-baseline gap-3 text-xs text-muted-foreground"
    >
      <span role="status" title={status} className="truncate">
        {status}
      </span>
      {(mode === 'running' || mode === 'paused' || mode === 'finished') && (
        <span data-task-progress className="font-mono tabular-nums">
          {telemetry.heightTask
            ? `${telemetry.heightMeters.toFixed(3)} m`
            : `${telemetry.stacked}/${telemetry.total}`}
        </span>
      )}
      {(mode === 'running' || mode === 'paused' || mode === 'finished') && (
        <span
          data-simulation-time
          className="w-[8ch] shrink-0 text-right font-mono tabular-nums whitespace-nowrap"
        >
          {telemetry.time.toFixed(1)} s
        </span>
      )}
    </div>
  );
}
function Toolbar({ runtime }: { runtime: Runtime | null }) {
  const { t: translate, i18n } = useTranslation();
  const t = useUI((s) => s.telemetry),
    mode = useUI((s) => s.mode),
    teacherRate = useUI((s) => s.teacherRate),
    policyStatus = useUI((s) => s.policyStatus);
  const settingsViewOpen = useUI((s) => s.settingsViewOpen);
  const config = useUI((s) => s.config);
  const theme = config.appearance.theme;
  const taskValue = taskPreset(config);
  const taskName = translate(`task.${taskValue}`);
  const settingsOpen = mode === 'editing' || settingsViewOpen,
    allowed = permissions(mode, t.teacher, policyStatus),
    running = mode === 'running',
    teacherActive = t.teacher && (running || mode === 'paused'),
    playLabel = translate(
      mode === 'paused'
        ? 'ui.resume'
        : running
          ? 'ui.pause'
          : mode === 'finished' && policyStatus === 'bound'
            ? 'ui.runAgain'
            : 'ui.run',
    );
  return (
    <header className="flex h-13 shrink-0 items-center border-b bg-background px-1 sm:gap-2 sm:px-5">
      <div className="flex shrink-0 items-center gap-0 min-[360px]:gap-1 sm:gap-2">
        <span className="mr-1 hidden text-sm font-semibold tracking-tight min-[480px]:inline sm:mr-4">
          Stackling
        </span>
        <Button
          id="play"
          className="w-9 shrink-0 lg:w-32"
          size="sm"
          onClick={() => runtime?.toggle()}
          disabled={!allowed.play}
          aria-label={playLabel}
        >
          {running ? <Pause /> : <Play />}
          <span className="hidden lg:inline">{playLabel}</span>
        </Button>
        {policyStatus === 'disconnected' && (
          <>
            <Button
              id="teacher"
              variant="ghost"
              size="sm"
              onClick={() => runtime?.teacher()}
              disabled={!allowed.teacher}
              aria-label={translate(teacherActive ? 'ui.stopStack' : 'ui.autoStack')}
            >
              {teacherActive ? <Square /> : <Layers2 />}
              <span className="hidden lg:inline">
                {translate(teacherActive ? 'ui.stopStack' : 'ui.autoStack')}
              </span>
            </Button>
            <Select
              value={String(teacherRate)}
              onValueChange={(value) => runtime?.setTeacherRate(Number(value))}
              disabled={!allowed.rate}
            >
              <SelectTrigger
                size="sm"
                aria-label={translate('ui.rate')}
                className="w-14 shrink-0 gap-1 border-transparent px-2 shadow-none hover:bg-accent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {TEACHER_RATES.map((rate) => (
                  <SelectItem key={rate} value={String(rate)}>
                    {rate}×
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Separator orientation="vertical" className="mx-1 hidden h-5! sm:block" />
        <IconButton
          label={translate('ui.reset')}
          disabled={!allowed.reset}
          onClick={() => runtime?.request()}
        >
          <RotateCcw />
        </IconButton>
        <IconButton
          label={translate('ui.generateScene')}
          disabled={!allowed.shuffle}
          onClick={() => runtime?.shuffle()}
        >
          <Shuffle />
        </IconButton>
      </div>
      <div className="min-w-2 flex-1" />
      <div className="flex min-w-0 items-center gap-0 min-[360px]:gap-1 sm:gap-2">
        <Select
          value={taskValue}
          onValueChange={(value) => runtime?.selectTask(value as TaskPreset)}
          disabled={!allowed.edit}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectTrigger
                id="task-preset"
                size="sm"
                aria-label={translate('ui.task')}
                className="w-44 min-w-0 border-transparent font-medium text-muted-foreground shadow-none hover:bg-accent xl:w-56"
              >
                <SelectValue className="min-w-0 flex-1">
                  <span data-current-task className="min-w-0 truncate">
                    {taskName}
                  </span>
                </SelectValue>
              </SelectTrigger>
            </TooltipTrigger>
            <TooltipContent>{taskName}</TooltipContent>
          </Tooltip>
          <SelectContent position="popper" align="end">
            {TASK_PRESETS.map((preset) => (
              <SelectItem key={preset} value={preset}>
                {translate(`task.${preset}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={theme}
          onValueChange={(value) => runtime?.setTheme(value)}
          disabled={!allowed.theme}
        >
          <SelectTrigger
            id="theme"
            size="sm"
            aria-label={translate('ui.theme')}
            className="hidden w-28 shrink-0 border-transparent shadow-none hover:bg-accent sm:flex"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {THEME_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {translate(`theme.${id}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <PolicyPanel runtime={runtime} />
        <Help runtime={runtime} />
        <Tooltip>
          <TooltipTrigger asChild>
            <SheetTrigger asChild>
              <Button
                size="icon-sm"
                variant={settingsOpen ? 'secondary' : 'ghost'}
                aria-label={translate('ui.settings')}
                disabled={!settingsOpen && !allowed.viewSettings}
              >
                <SlidersHorizontal />
              </Button>
            </SheetTrigger>
          </TooltipTrigger>
          <TooltipContent>{translate('ui.settings')}</TooltipContent>
        </Tooltip>
        <Button
          id="language"
          variant="ghost"
          size="sm"
          className="shrink-0 px-2 text-xs"
          aria-label={i18n.resolvedLanguage === 'zh' ? 'Switch to English' : '切换为中文'}
          onClick={() => void i18n.changeLanguage(i18n.resolvedLanguage === 'zh' ? 'en' : 'zh')}
        >
          {i18n.resolvedLanguage === 'zh' ? 'EN' : '中文'}
        </Button>
      </div>
    </header>
  );
}
function SettingsPanel({ runtime, open }: { runtime: Runtime | null; open: boolean }) {
  const { t } = useTranslation();
  const live = useUI();
  const retained = useRef(live);
  // Keep the last visible draft throughout Radix's exit animation.
  if (open) retained.current = live;
  const state = retained.current;
  const readOnly = state.mode !== 'editing',
    policyStatus = state.policyStatus;
  if (live.shortcutsOpen || live.policyOpen) return null;
  return (
    <SheetContent
      variant="floating"
      inert={!open}
      onCloseAutoFocus={onPanelCloseAutoFocus}
      aria-describedby={undefined}
      showCloseButton={false}
      onInteractOutside={(event) => event.preventDefault()}
      className={`${floatingCard} h-[min(680px,calc(100dvh-76px))] sm:h-[min(680px,calc(100dvh-92px))]`}
    >
      <SheetHeader className="h-14 shrink-0 flex-row items-center justify-between px-5 py-0">
        <SheetTitle className="text-sm font-medium">
          {t('ui.settings')}
          {readOnly && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t(policyStatus === 'disconnected' ? 'ui.readOnly' : 'policy.managed')}
            </span>
          )}
        </SheetTitle>
        <SheetClose asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t('ui.closeSettings')}>
            <X />
          </Button>
        </SheetClose>
      </SheetHeader>
      <Settings runtime={runtime} readOnly={readOnly} state={state} />
    </SheetContent>
  );
}

function App() {
  const { t } = useTranslation();
  const state = useUI();
  const host = useRef<HTMLDivElement>(null),
    [runtime, setRuntime] = useState<Runtime | null>(null);
  const settingsOpen = useUI((s) => s.mode === 'editing' || s.settingsViewOpen),
    error = useUI((s) => s.error);
  useEffect(() => {
    let disposed = false,
      instance: Runtime | undefined;
    void Runtime.create(host.current!)
      .then((value) => {
        if (disposed) {
          value.dispose();
          return;
        }
        instance = value;
        setRuntime(value);
        Object.assign(window, { stacklingUI: value });
      })
      .catch((error) => useUI.setState({ error: String(error) }));
    return () => {
      disposed = true;
      instance?.dispose();
      delete (window as any).stacklingUI;
    };
  }, []);
  return (
    <TooltipProvider delayDuration={350}>
      <Sheet
        open={settingsOpen}
        modal={false}
        onOpenChange={(open) => (open ? runtime?.openSettings() : runtime?.closeSettings())}
      >
        <div className="flex h-dvh flex-col">
          <Toolbar runtime={runtime} />
          <main className="relative min-h-0 flex-1">
            <div ref={host} id="viewport" className="viewport" />
            {runtime && state.viewport === 'orbit' && <Compass runtime={runtime} />}
            <Button
              variant="secondary"
              size="sm"
              className="absolute top-4 right-5 gap-2 shadow-sm"
              disabled={
                !runtime ||
                !permissions(state.mode, state.telemetry.teacher, state.policyStatus).view
              }
              aria-label={t(state.viewport === 'head' ? 'ui.showOverview' : 'ui.showFirstPerson')}
              onClick={() => runtime?.setViewport(state.viewport === 'head' ? 'orbit' : 'head')}
            >
              <Camera className="size-4" />
              {t(state.viewport === 'head' ? 'ui.overview' : 'ui.firstPerson')}
            </Button>
            <RunStatus />
            <SensorPreview runtime={runtime} />
            {error && (
              <div
                role="alert"
                className="absolute top-4 left-1/2 flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm text-destructive shadow-sm"
              >
                <ErrorText value={error} />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t('ui.dismissError')}
                  onClick={() => useUI.setState({ error: '' })}
                >
                  <X />
                </Button>
              </div>
            )}
          </main>
          <SettingsPanel runtime={runtime} open={settingsOpen} />
        </div>
      </Sheet>
    </TooltipProvider>
  );
}
createRoot(document.getElementById('app')!).render(<App />);
