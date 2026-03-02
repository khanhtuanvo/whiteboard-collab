'use client';

interface CursorProps {
  x: number;
  y: number;
  color: string;
  name: string;
}

export default function Cursor({ x, y, color, name }: CursorProps) {
  return (
    <div
      className="absolute pointer-events-none z-20"
      style={{ left: x, top: y, transform: 'translate(-2px, -2px)' }}
    >
      {/* Cursor arrow */}
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path
          d="M4 2L4 16L7.5 12.5L10.5 18L12.5 17L9.5 11L14 11L4 2Z"
          fill={color}
          stroke="white"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      {/* Name label */}
      <div
        className="text-xs text-white px-1.5 py-0.5 rounded whitespace-nowrap mt-0.5 leading-tight"
        style={{ backgroundColor: color }}
      >
        {name}
      </div>
    </div>
  );
}
