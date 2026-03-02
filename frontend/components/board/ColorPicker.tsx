'use client';

import { useState } from 'react';

const PRESET_COLORS = [
  '#000000', '#ffffff', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#3b82f6', '#8b5cf6',
  '#ec4899', '#06b6d4', '#fef08a', '#d97706',
];

interface ColorPickerProps {
  fill?: string;
  stroke?: string;
  onChange: (changes: { fill?: string; stroke?: string }) => void;
}

export default function ColorPicker({ fill, stroke, onChange }: ColorPickerProps) {
  const [fillInput, setFillInput] = useState(fill ?? '');
  const [strokeInput, setStrokeInput] = useState(stroke ?? '');

  const handleFillInput = (val: string) => {
    setFillInput(val);
    if (/^#[0-9a-f]{6}$/i.test(val)) onChange({ fill: val });
  };

  const handleStrokeInput = (val: string) => {
    setStrokeInput(val);
    if (/^#[0-9a-f]{6}$/i.test(val)) onChange({ stroke: val });
  };

  return (
    <div className="bg-white shadow-lg rounded-lg p-3 flex flex-col gap-3 w-48">
      {/* Fill */}
      <div>
        <p className="text-xs text-gray-500 mb-1 font-medium">Fill</p>
        <div className="flex flex-wrap gap-1 mb-1">
          {PRESET_COLORS.map(c => (
            <button
              key={c}
              className={`w-5 h-5 rounded border-2 transition-transform hover:scale-110 ${fill === c ? 'border-blue-500 scale-110' : 'border-gray-200'}`}
              style={{ backgroundColor: c }}
              onClick={() => { setFillInput(c); onChange({ fill: c }); }}
              title={c}
            />
          ))}
        </div>
        <input
          type="text"
          className="w-full border rounded px-2 py-1 text-xs font-mono"
          placeholder="#3b82f6"
          value={fillInput}
          onChange={e => handleFillInput(e.target.value)}
          maxLength={7}
        />
      </div>

      {/* Stroke */}
      <div>
        <p className="text-xs text-gray-500 mb-1 font-medium">Stroke</p>
        <div className="flex flex-wrap gap-1 mb-1">
          {PRESET_COLORS.map(c => (
            <button
              key={c}
              className={`w-5 h-5 rounded border-2 transition-transform hover:scale-110 ${stroke === c ? 'border-blue-500 scale-110' : 'border-gray-200'}`}
              style={{ backgroundColor: c }}
              onClick={() => { setStrokeInput(c); onChange({ stroke: c }); }}
              title={c}
            />
          ))}
        </div>
        <input
          type="text"
          className="w-full border rounded px-2 py-1 text-xs font-mono"
          placeholder="#000000"
          value={strokeInput}
          onChange={e => handleStrokeInput(e.target.value)}
          maxLength={7}
        />
      </div>
    </div>
  );
}
