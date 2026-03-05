'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Element, ElementType } from '@/types/element';
import api from '@/lib/api';

interface ClusterResult {
  id: string;
  cluster: number;
  suggestedX: number;
  suggestedY: number;
}

interface ClusterSuggestionsProps {
  boardId: string;
  elements: Element[];
  onElementUpdate: (id: string, updates: Partial<Element>) => void;
}

export default function ClusterSuggestions({ boardId, elements, onElementUpdate }: ClusterSuggestionsProps) {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<ClusterResult[] | null>(null);

  const stickyNotes = elements.filter(e => e.type === ElementType.STICKY_NOTE);
  const canCluster = stickyNotes.length >= 3;

  const handleAutoOrganize = async () => {
    setLoading(true);
    try {
      const payload = stickyNotes.map(e => ({
        id: e.id,
        text: e.properties.text ?? '',
        x: e.properties.x ?? 0,
        y: e.properties.y ?? 0,
      }));
      const { data } = await api.post<ClusterResult[]>(`/api/boards/${boardId}/ai/cluster`, payload);
      setSuggestions(data);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to get cluster suggestions');
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = () => {
    if (!suggestions) return;
    for (const s of suggestions) {
      const el = elements.find(e => e.id === s.id);
      if (!el) continue;
      onElementUpdate(s.id, {
        properties: { ...el.properties, x: s.suggestedX, y: s.suggestedY },
      });
    }
    const clusterCount = new Set(suggestions.map(s => s.cluster)).size;
    toast.success(`Organized ${suggestions.length} notes into ${clusterCount} clusters`);
    setSuggestions(null);
  };

  const handleReject = () => setSuggestions(null);

  return (
    <>
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

      {suggestions && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl p-6 w-96">
            <h2 className="text-base font-semibold mb-1">Auto-Organize Preview</h2>
            <p className="text-sm text-gray-500 mb-4">
              {suggestions.length} sticky notes will be grouped into{' '}
              <strong>{new Set(suggestions.map(s => s.cluster)).size} clusters</strong> based on
              semantic similarity.
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
              >
                Accept Layout
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
