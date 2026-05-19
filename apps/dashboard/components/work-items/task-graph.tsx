"use client";

import type {
  TaskNode,
  TaskNodeStatus,
  WorkItemGraphResponse,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

/**
 * V4.2 Task Graph view — pure SVG topology, no graph library dependency.
 *
 * Layout strategy (kept intentionally dumb so a11y / unit tests can
 * inspect coordinates):
 *
 *  - The graph response provides a topological layering `levels[i]`.
 *    `levels[i]` becomes the i-th row of equally-spaced node boxes.
 *  - Edges are drawn as orthogonal two-segment paths between source and
 *    target box centres (down → horizontal → down). Each `<path>` carries
 *    `data-edge`, `data-from`, `data-to`, and `data-blocked` attributes
 *    so unit tests and a11y tooling can assert structure without
 *    pixel-snapshotting SVG geometry.
 *  - Nodes on the critical path are flagged via `data-critical="true"`
 *    and get a ring border. Blocked-by-dependency downstream edges are
 *    rendered as red dashed paths.
 *  - Empty graphs (no tasks) render a placeholder rather than an empty
 *    SVG so tests can assert on `task-graph-empty`.
 */

const NODE_W = 200;
const NODE_H = 80;
const COL_GAP = 64;
const ROW_GAP = 40;
const PADDING = 16;

const STATUS_TONE: Record<TaskNodeStatus, string> = {
  ready: "bg-warning-soft text-warning-fg",
  running: "bg-info-soft text-info-fg",
  running_coding: "bg-info-soft text-info-fg",
  running_reviewer: "bg-info-soft text-info-fg",
  running_test_evidence: "bg-info-soft text-info-fg",
  awaiting_human_review: "bg-success-soft text-success-fg",
  completed: "bg-success-soft text-success-fg",
  failed: "bg-danger-soft text-danger-fg",
  blocked: "bg-danger-soft text-danger-fg",
  needs_rework: "bg-warning-soft text-warning-fg",
  blocked_by_dependency: "bg-info-soft text-info-fg",
  skipped: "bg-fg-subtle/20 text-fg-subtle",
  planned: "bg-fg-subtle/20 text-fg-subtle",
};

export interface TaskGraphProps {
  graph: WorkItemGraphResponse;
  tasks: readonly TaskNode[];
}

interface NodeBox {
  taskId: string;
  level: number;
  column: number;
  x: number;
  y: number;
  title: string;
  status: TaskNodeStatus;
  critical: boolean;
}

export function TaskGraph({ graph, tasks }: TaskGraphProps) {
  const t = useTranslations("workItem.taskGraph");

  if (graph.levels.length === 0 || tasks.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p
            data-testid="task-graph-empty"
            className="text-xs text-fg-subtle"
          >
            {t("empty")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const taskById = new Map<string, TaskNode>(
    tasks.map((task) => [task.taskId, task]),
  );
  const critical = new Set(graph.criticalPathTaskIds);

  // Determine each task's row + column and absolute coordinates so we
  // can compute edge endpoints without going through DOM measurement.
  const nodes: NodeBox[] = [];
  const positionById = new Map<string, NodeBox>();
  graph.levels.forEach((row, level) => {
    row.forEach((taskId, column) => {
      const task = taskById.get(taskId);
      if (!task) return;
      const node: NodeBox = {
        taskId,
        level,
        column,
        x: PADDING + column * (NODE_W + COL_GAP),
        y: PADDING + level * (NODE_H + ROW_GAP),
        title: task.title,
        status: task.status,
        critical: critical.has(taskId),
      };
      nodes.push(node);
      positionById.set(taskId, node);
    });
  });

  const widestRow = graph.levels.reduce(
    (max, row) => Math.max(max, row.length),
    1,
  );
  const svgWidth = PADDING * 2 + widestRow * NODE_W + (widestRow - 1) * COL_GAP;
  const svgHeight =
    PADDING * 2 +
    graph.levels.length * NODE_H +
    Math.max(0, graph.levels.length - 1) * ROW_GAP;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-auto" data-testid="task-graph-canvas">
          <svg
            width={svgWidth}
            height={svgHeight}
            role="img"
            aria-label={t("ariaLabel")}
            className="text-fg"
          >
            <g aria-label={t("edgesAriaLabel")}>
              {graph.edges.map((edge) => {
                const from = positionById.get(edge.from);
                const to = positionById.get(edge.to);
                if (!from || !to) return null;
                const x1 = from.x + NODE_W / 2;
                const y1 = from.y + NODE_H;
                const x2 = to.x + NODE_W / 2;
                const y2 = to.y;
                const midY = (y1 + y2) / 2;
                const d = `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
                const downstream = taskById.get(edge.to);
                const blocked =
                  downstream?.status === "blocked_by_dependency";
                return (
                  <path
                    key={`${edge.from}->${edge.to}`}
                    d={d}
                    data-edge="true"
                    data-from={edge.from}
                    data-to={edge.to}
                    data-blocked={blocked ? "true" : "false"}
                    fill="none"
                    stroke={blocked ? "currentColor" : "currentColor"}
                    strokeOpacity={blocked ? 0.9 : 0.5}
                    strokeWidth={blocked ? 2 : 1.5}
                    strokeDasharray={blocked ? "6 4" : undefined}
                    className={cn(
                      blocked
                        ? "text-danger-fg"
                        : "text-fg-subtle",
                    )}
                  />
                );
              })}
            </g>
            <g aria-label={t("nodesAriaLabel")}>
              {nodes.map((node) => (
                <g
                  key={node.taskId}
                  data-testid={`task-graph-node-${node.taskId}`}
                  data-level={node.level}
                  data-critical={node.critical ? "true" : "false"}
                  transform={`translate(${node.x}, ${node.y})`}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={8}
                    ry={8}
                    className={cn(
                      "fill-surface-1 stroke-border",
                      node.critical && "stroke-warning-fg",
                    )}
                    strokeWidth={node.critical ? 2 : 1}
                  />
                  <foreignObject
                    x={8}
                    y={8}
                    width={NODE_W - 16}
                    height={NODE_H - 16}
                  >
                    <div className="flex h-full flex-col justify-between">
                      <span className="truncate text-sm font-medium text-fg">
                        {node.title}
                      </span>
                      <span
                        className={cn(
                          "inline-flex w-fit items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
                          STATUS_TONE[node.status],
                        )}
                      >
                        {node.status}
                      </span>
                    </div>
                  </foreignObject>
                </g>
              ))}
            </g>
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
