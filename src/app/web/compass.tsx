import { useTranslation } from 'react-i18next';
import { useEffect, useRef } from 'react';
import type { Runtime } from './runtime';

const directions = ['N', 'E', 'S', 'W'];

export function Compass({ runtime }: { runtime: Runtime }) {
  const { t } = useTranslation();
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current!,
      axes = svg.querySelector('g')!,
      labels = svg.querySelectorAll('text');
    const update = () => {
      const angle = runtime.orbit.getAzimuthalAngle();
      axes.setAttribute('transform', `rotate(${(angle * 180) / Math.PI} 40 40)`);
      labels.forEach((label, i) => {
        const direction = angle + (i * Math.PI) / 2;
        label.setAttribute('x', String(40 + 29 * Math.sin(direction)));
        label.setAttribute('y', String(40 - 29 * Math.cos(direction)));
      });
    };
    update();
    runtime.orbit.addEventListener('change', update);
    return () => runtime.orbit.removeEventListener('change', update);
  }, [runtime]);

  return (
    <svg
      ref={ref}
      role="img"
      aria-label={t('ui.compass')}
      viewBox="0 0 80 80"
      className="pointer-events-none absolute top-3 left-3 size-20 select-none text-primary sm:top-4 sm:left-4"
    >
      <g>
        <path d="M40 25V56 M24 40H56" stroke="currentColor" strokeOpacity="0.45" />
        <path d="M40 20L37 27H43Z" fill="currentColor" />
      </g>
      {directions.map((direction, i) => (
        <text
          key={direction}
          x={40 + 29 * Math.sin((i * Math.PI) / 2)}
          y={40 - 29 * Math.cos((i * Math.PI) / 2)}
          textAnchor="middle"
          dominantBaseline="central"
          className={i === 0 ? 'fill-primary font-semibold' : 'fill-muted-foreground'}
          fontSize="11"
        >
          {t(`direction.${direction}`)}
        </text>
      ))}
    </svg>
  );
}
