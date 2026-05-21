import type {
  ReviewerAgentReport,
  ReviewFeedbackSummary,
  ReviewReworkItem,
  ReviewReworkPlan,
  ReviewReworkSourceRef,
} from "@issuepilot/shared-contracts";

import { classifyComment, classifyFinding } from "./classify.js";
import type {
  BuildReviewReworkPlanInput,
  BuiltReviewReworkPlan,
} from "./types.js";

const PRIORITY_RANK: Record<ReviewReworkItem["priority"], number> = {
  blocking: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function deriveTitle(body: string): string {
  const first = body.split(/\r?\n/)[0]?.trim() ?? "";
  if (first.length === 0) return "Review item";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

function buildItemsFromSummary(
  summary: ReviewFeedbackSummary | undefined,
): ReviewReworkItem[] {
  if (!summary) return [];
  return summary.comments.map((c) => {
    const signal = classifyComment(c.body);
    return {
      itemId: `cmt-${c.noteId}`,
      status: "open",
      category: signal.category,
      priority: signal.priority,
      title: deriveTitle(c.body),
      summary: c.body,
      targetFiles: [],
      suggestedValidation: [],
      sourceRefs: [
        {
          kind: "human_review_comment",
          id: `note-${c.noteId}`,
          url: c.url,
          author: c.author,
          createdAt: c.createdAt,
        },
      ],
      confidence: signal.confidence,
    } satisfies ReviewReworkItem;
  });
}

function buildItemsFromFindings(
  reports: ReviewerAgentReport[],
): ReviewReworkItem[] {
  const items: ReviewReworkItem[] = [];
  for (const report of reports) {
    report.reviewer.findings.forEach((f, idx) => {
      const signal = classifyFinding(f);
      const targetFile = f.locationHint?.filePath ?? "";
      const sourceRef: ReviewReworkSourceRef = {
        kind: "ai_reviewer_finding",
        id: `${report.agentReportId}#${idx}`,
        runnerKind: report.runnerKind,
        agentReportId: report.agentReportId,
      };
      items.push({
        itemId: `fnd-${report.agentReportId}-${idx}`,
        status: "open",
        category: signal.category,
        priority: signal.priority,
        title: f.message.split(/\r?\n/)[0] ?? f.category,
        summary: f.message,
        targetFiles: targetFile ? [targetFile] : [],
        ...(report.taskId ? { taskId: report.taskId } : {}),
        suggestedValidation: [],
        sourceRefs: [sourceRef],
        confidence: signal.confidence,
      });
    });
  }
  return items;
}

function pickStronger(
  a: ReviewReworkItem,
  b: ReviewReworkItem,
): { winner: ReviewReworkItem; loser: ReviewReworkItem } {
  const aRank = PRIORITY_RANK[a.priority];
  const bRank = PRIORITY_RANK[b.priority];
  if (aRank <= bRank) return { winner: a, loser: b };
  return { winner: b, loser: a };
}

function fileNamesOf(item: ReviewReworkItem): string[] {
  return item.targetFiles.map((f) => f.split("/").pop()!.toLowerCase());
}

function mentionsFile(item: ReviewReworkItem, fileNames: string[]): boolean {
  if (fileNames.length === 0) return false;
  const haystack = `${item.title}\n${item.summary}`.toLowerCase();
  return fileNames.some((name) => name.length > 0 && haystack.includes(name));
}

/**
 * 把同 category 且语义重叠的条目合并成单条。重叠判定按优先级：
 *
 *  1. 若两条目都标注了 targetFiles 且存在交集，视为同一处。
 *  2. 否则若任一条目的 file basename 出现在另一条的标题 / 摘要里，
 *     视为同一处（典型场景：human 评论 body 提到 util.ts，reviewer
 *     finding locationHint = src/util.ts）。
 *  3. 否则视为独立条目。
 *
 * 合并时优先级高的条目保留为主体（title / category / priority），
 * 另一条目的 sourceRefs 追加到主条目。同时取较完整的 targetFiles。
 * 这套规则覆盖 spec §7 "dedupe by file + topic" 与本计划测试中的
 * "merges duplicate source refs" 场景。
 */
function dedupe(items: ReviewReworkItem[]): ReviewReworkItem[] {
  const result: ReviewReworkItem[] = [];
  for (const item of items) {
    const existing = result.find((other) => {
      if (other.category !== item.category) return false;
      const shareFile =
        other.targetFiles.length > 0 &&
        item.targetFiles.length > 0 &&
        other.targetFiles.some((f) => item.targetFiles.includes(f));
      if (shareFile) return true;
      if (mentionsFile(item, fileNamesOf(other))) return true;
      if (mentionsFile(other, fileNamesOf(item))) return true;
      return false;
    });
    if (!existing) {
      result.push({ ...item, sourceRefs: [...item.sourceRefs] });
      continue;
    }
    const { winner, loser } = pickStronger(existing, item);
    existing.title = winner.title;
    existing.priority = winner.priority;
    existing.summary = winner.summary;
    existing.confidence = Math.max(existing.confidence, item.confidence);
    if (item.targetFiles.length > existing.targetFiles.length) {
      existing.targetFiles = [...item.targetFiles];
    }
    if (!existing.taskId && winner.taskId) {
      existing.taskId = winner.taskId;
    } else if (!existing.taskId && loser.taskId) {
      existing.taskId = loser.taskId;
    }
    existing.sourceRefs = [...existing.sourceRefs, ...item.sourceRefs];
  }
  return result;
}

function sortItems(items: ReviewReworkItem[]): ReviewReworkItem[] {
  return [...items].sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    return a.title.localeCompare(b.title);
  });
}

export function buildReviewReworkPlan(
  input: BuildReviewReworkPlanInput,
): BuiltReviewReworkPlan {
  const items = sortItems(
    dedupe([
      ...buildItemsFromSummary(input.summary),
      ...buildItemsFromFindings(input.reviewerReports),
    ]),
  );

  const plan: ReviewReworkPlan = {
    planId: input.randomId(),
    runId: input.runId,
    issueIid: input.issueIid,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    status: "draft",
    generatedAt: input.now().toISOString(),
    items,
    ...(input.summary !== undefined
      ? { sourceSummaryId: `${input.summary.mrIid}:${input.summary.cursor}` }
      : {}),
  };
  return plan;
}
