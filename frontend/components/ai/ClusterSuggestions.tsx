'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Element, ElementType } from '@/types/element';
import axios from 'axios';
import api from '@/lib/api';

interface ClusterResult {
  id: string;
  cluster: number;
  suggestedX: number;
  suggestedY: number;
}

type LayoutMode = 'preserve' | 'aggressive';

interface ClusterSuggestionsProps {
  boardId: string;
  elements: Element[];
  onApplySuggestions: (suggestions: ClusterResult[]) => Promise<void> | void;
}

export default function ClusterSuggestions({ boardId, elements, onApplySuggestions }: ClusterSuggestionsProps) {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<ClusterResult[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('preserve');

  const stickyNotes = elements.filter(e => e.type === ElementType.STICKY_NOTE);
  const canCluster = stickyNotes.length >= 3;

  const handleAutoOrganize = async () => {
    setLoading(true);
    try {
      const notes = stickyNotes.map(e => ({
        id: e.id,
        text: e.properties.text ?? '',
        x: e.properties.x ?? 0,
        y: e.properties.y ?? 0,
        width: e.properties.width ?? 200,
        height: e.properties.height ?? 200,
      }));

      const avgWidth = notes.reduce((sum, note) => sum + (note.width ?? 200), 0) / notes.length;
      const avgHeight = notes.reduce((sum, note) => sum + (note.height ?? 200), 0) / notes.length;

      const options = layoutMode === 'preserve'
        ? { layoutMode, noteWidth: Math.round(avgWidth), noteHeight: Math.round(avgHeight) }
        : { layoutMode, alpha: 1, maxDisplacement: 2000, noteWidth: Math.round(avgWidth), noteHeight: Math.round(avgHeight) };

      const { data } = await api.post<ClusterResult[]>(`/api/boards/${boardId}/ai/cluster`, {
        notes,
        options,
      });
      setSuggestions(data);
    } catch (err: unknown) {
      toast.error(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to get cluster suggestions') : 'Failed to get cluster suggestions');
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async () => {
    if (!suggestions) return;
    setApplying(true);
    try {
      await onApplySuggestions(suggestions);
      const clusterCount = new Set(suggestions.map(s => s.cluster)).size;
      toast.success(`Organized ${suggestions.length} notes into ${clusterCount} clusters`);
      setSuggestions(null);
    } catch (err: unknown) {
      toast.error(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to apply cluster layout') : 'Failed to apply cluster layout');
    } finally {
      setApplying(false);
    }
  };

  const handleReject = () => setSuggestions(null);

  return (
    <>
      <div className="flex items-center gap-2">
        <select
          value={layoutMode}
          onChange={(e) => setLayoutMode(e.target.value as LayoutMode)}
          className="h-8 rounded border px-2 text-xs"
          title="Choose how strongly notes move during auto-organize"
        >
          <option value="preserve">Preserve Proximity</option>
          <option value="aggressive">Aggressive Organize</option>
        </select>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleAutoOrganize}
          disabled={!canCluster || loading}
          title={canCluster ? 'Auto-organize sticky notes by topic' : 'Need at least 3 sticky notes'}
          className="gap-1"
        >
          <Sparkles className="h-4 w-4" />
          {loading ? 'Analyzing…' : 'Auto-Organize'}
        </Button>
      </div>

      {suggestions && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl p-6 w-96">
            <h2 className="text-base font-semibold mb-1">Auto-Organize Preview</h2>
            <p className="text-sm text-gray-500 mb-4">
              {suggestions.length} sticky notes will be grouped into{' '}
              <strong>{new Set(suggestions.map(s => s.cluster)).size} clusters</strong> based on
              semantic similarity.
            </p>

            <p className="text-xs text-gray-500 mb-3">
              Mode: <strong>{layoutMode === 'preserve' ? 'Preserve Proximity' : 'Aggressive Organize'}</strong>
            </p>

            <div className="space-y-1.5 mb-5 max-h-52 overflow-y-auto">
              {Array.from(new Set(suggestions.map(s => s.cluster)))
                .sort((a, b) => a - b)
                .map(cluster => {
                  const clusterNotes = suggestions.filter(s => s.cluster === cluster);
                  const previews = clusterNotes.map(s => {
                    const el = elements.find(e => e.id === s.id);
                    return el?.properties.text?.slice(0, 40) || '(empty)';
                  });
                  return (
                    <div key={cluster} className="bg-gray-50 rounded p-2 text-xs">
                      <span className="font-medium text-gray-700">Cluster {cluster + 1}</span>
                      <span className="text-gray-400 ml-1">({clusterNotes.length} notes)</span>
                      <div className="text-gray-500 mt-0.5 truncate">
                        {previews.slice(0, 3).join(' · ')}
                        {previews.length > 3 && ' …'}
                      </div>
                    </div>
                  );
                })}
            </div>

            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 text-sm rounded border hover:bg-gray-50"
                onClick={handleReject}
              >
                Reject
              </button>
              <button
                className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
                onClick={handleAccept}
                disabled={applying}
              >
                {applying ? 'Applying…' : 'Accept Layout'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
