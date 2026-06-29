import { useEffect } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  SelectionMode,
  type NodeTypes,
} from "@xyflow/react";
import { useStudio } from "./store";
import { useAppMode } from "./appMode";
import { useLibrary } from "./libraryStore";
import { VNode } from "./nodes/VNode";
import { Toolbar } from "./components/Toolbar";
import { Inspector } from "./components/Inspector";
import { Lightbox } from "./components/Lightbox";
import { ComicStudio } from "./comic/ComicStudio";
import { LibraryPanel } from "./comic/LibraryPanel";
import { Toaster } from "./components/ui";

const nodeTypes: NodeTypes = { vnode: VNode };

export default function App() {
  const mode = useAppMode((s) => s.mode);
  const initLibrary = useLibrary((s) => s.init);

  // The cross-project library loads once and lives for the app's lifetime, so its
  // slide-over and the training socket are available in both modes.
  useEffect(() => {
    initLibrary();
  }, [initLibrary]);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      {mode === "storyboard" ? <ComicStudio /> : <CanvasView />}
      <LibraryPanel />
      <Lightbox />
      <Toaster />
    </div>
  );
}

/** The raw node-graph workspace. Its store only initializes when this view mounts. */
function CanvasView() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, select, init } = useStudio();

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => select(n.id)}
            onPaneClick={() => select(null)}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ animated: true }}
            /* Selection & navigation (Figma-style, trackpad-friendly) */
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1, 2]}
            panOnScroll
            selectionKeyCode={null}
            multiSelectionKeyCode={["Meta", "Shift"]}
            deleteKeyCode={["Backspace", "Delete"]}
            elementsSelectable
            edgesFocusable
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="var(--v-border-strong)"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-border bg-surface">
          <Inspector />
        </aside>
      </div>
    </div>
  );
}
