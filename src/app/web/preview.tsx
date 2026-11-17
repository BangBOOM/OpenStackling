import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { Camera, ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from './components/ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './components/ui/collapsible';
import { cn } from './lib/utils';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';
import { useUI } from './store';
import type { Runtime, Preview } from './runtime';
function Canvas({ runtime, depth }: { runtime: Runtime | null; depth: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const headMounted = useUI((s) => s.previewConfig.camera.mount === 'head');
  useEffect(
    () =>
      runtime?.subscribePreview(({ frame, width, height }: Preview) => {
        const canvas = ref.current;
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        let pixels = new Uint8ClampedArray(frame.rgb);
        if (depth && frame.depth) {
          pixels = new Uint8ClampedArray(width * height * 4);
          for (let i = 0; i < width * height; i++) {
            const mm = frame.depth[i * 2] + frame.depth[i * 2 + 1] * 256,
              minimum = headMounted ? 0.15 : 1,
              span = headMounted ? 1.85 : 3,
              shade =
                mm === 0 ? 0 : Math.max(0, Math.min(255, 255 * (1 - (mm / 1000 - minimum) / span)));
            pixels.set([shade, shade, shade, 255], i * 4);
          }
        }
        canvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
      }),
    [runtime, depth, headMounted],
  );
  return (
    <canvas
      ref={ref}
      className="sensor-image max-h-[calc(100dvh-160px)] object-contain"
      aria-label={t(depth ? 'ui.depthPreview' : 'ui.rgbPreview')}
    />
  );
}
export function SensorPreview({ runtime }: { runtime: Runtime | null }) {
  const { t } = useTranslation();
  const open = useUI((s) => s.previewOpen),
    camera = useUI((s) => s.previewConfig.camera),
    [expanded, setExpanded] = useState(false),
    [mode, setMode] = useState('rgb');
  useEffect(() => {
    if (!camera.depth) setMode('rgb');
  }, [camera.depth]);
  const controls = camera.depth && (
    <Tabs value={mode} onValueChange={setMode}>
      <TabsList className="h-7 w-full rounded-none">
        <TabsTrigger value="rgb" className="text-xs">
          RGB
        </TabsTrigger>
        <TabsTrigger value="depth" className="text-xs">
          {t('ui.depth')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
  return (
    <Collapsible
      open={open}
      onOpenChange={(previewOpen) => useUI.setState({ previewOpen })}
      data-sensor-preview
      className={cn(
        'absolute bottom-4 left-4 z-10 overflow-hidden rounded-lg border bg-background shadow-sm sm:bottom-5 sm:left-5',
        open && expanded ? 'w-[min(480px,calc(100vw-40px))]' : 'w-44 sm:w-48',
      )}
    >
      <div className="flex h-9 items-center px-1">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="flex-1 justify-start px-2 text-xs">
            <Camera className="size-3.5" />
            {camera.mount === 'head' ? t('ui.headCamera') : t(`direction.${camera.position}`)}
            <span className="ml-auto">
              {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
            </span>
          </Button>
        </CollapsibleTrigger>
        {open && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t(expanded ? 'ui.shrinkPreview' : 'ui.expandPreview')}
            aria-pressed={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
        )}
      </div>
      <CollapsibleContent>
        {controls}
        <Canvas runtime={runtime} depth={mode === 'depth'} />
      </CollapsibleContent>
    </Collapsible>
  );
}
