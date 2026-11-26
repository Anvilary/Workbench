import { useId, useMemo } from 'react';

interface Props {
  data: readonly number[];
  width?: number;
  height?: number;
  color?: string;
  min?: number;
  max?: number;
  className?: string;
}

export function PerformanceSparkline({
  data,
  width = 110,
  height = 26,
  color = '#d97442',
  min: explicitMin,
  max: explicitMax,
  className = '',
}: Props): JSX.Element {
  const gradientId = useId();

  const { pathD, fillD } = useMemo(() => {
    if (!data || data.length < 2) {
      return { pathD: '', fillD: '' };
    }

    const padding = 2;
    const drawWidth = width - padding * 2;
    const drawHeight = height - padding * 2;

    const dataMin = explicitMin !== undefined ? explicitMin : Math.min(...data);
    const dataMax = explicitMax !== undefined ? explicitMax : Math.max(...data);
    const range = dataMax - dataMin || 1;

    const points: [number, number][] = data.map((val, idx) => {
      const x = padding + (idx / (data.length - 1)) * drawWidth;
      const normalizedY = (val - dataMin) / range;
      const y = padding + drawHeight - normalizedY * drawHeight;
      return [x, y];
    });

    if (points.length < 2 || !points[0] || !points[points.length - 1]) {
      return { pathD: '', fillD: '' };
    }

    const pathD = points.reduce((acc, point, idx) => {
      const [x, y] = point;
      return idx === 0 ? `M ${x.toFixed(1)},${y.toFixed(1)}` : `${acc} L ${x.toFixed(1)},${y.toFixed(1)}`;
    }, '');

    const lastX = points[points.length - 1]![0];
    const firstX = points[0]![0];
    const bottomY = height - padding;
    const fillD = `${pathD} L ${lastX.toFixed(1)},${bottomY} L ${firstX.toFixed(1)},${bottomY} Z`;

    return { pathD, fillD };
  }, [data, width, height, explicitMin, explicitMax]);

  if (!pathD) {
    return (
      <div
        className={`wb-sparkline-placeholder ${className}`}
        style={{ width, height }}
        aria-hidden="true"
      />
    );
  }

  return (
    <svg
      className={`wb-sparkline ${className}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={fillD} fill={`url(#${gradientId})`} />
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
