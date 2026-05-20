// @vitest-environment jsdom
import type {
  AgentReport,
  GetPipelineResponse,
  WorkItemDetailResponse,
} from "@issuepilot/shared-contracts";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "../../../i18n/messages/en.json";
import { renderWithIntl as render } from "../../../test/intl";

import WorkItemDetailRoute from "./page";
import {
  ApiError,
  getAgentReport,
  getPipeline,
  getWorkItem,
} from "../../../lib/api";

vi.mock("../../../lib/api", () => ({
  ApiError: class ApiError extends Error {
    code: string | undefined;
    constructor(
      message: string,
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(message);
      if (body && typeof body === "object") {
        const code = (body as { code?: unknown }).code;
        if (typeof code === "string") this.code = code;
      }
    }
  },
  getWorkItem: vi.fn(),
  getPipeline: vi.fn(),
  getAgentReport: vi.fn(),
}));

// `next/headers` is only available inside the Next.js runtime; in vitest
// we stub it so the Server Component can read the persisted active
// project cookie that ProjectSwitcher writes on selection. This is the
// V4.2 review C3 contract: SSR for team-mode work-item routes must
// attach `x-issuepilot-project`, otherwise the orchestrator returns
// HTTP 400 `project_header_required` and the detail page renders an
// error instead of the report packet.
const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (key: string) => {
      const value = cookieStore.get(key);
      return value === undefined ? undefined : { name: key, value };
    },
  }),
}));

vi.mock("next-intl/server", async () => {
  const { Fragment } = await import("react");
  function lookup(key: string): string {
    const parts = key.split(".");
    let cur: unknown = enMessages;
    for (const part of parts) {
      if (cur && typeof cur === "object" && part in cur) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return key;
      }
    }
    return typeof cur === "string" ? cur : key;
  }
  function makeTranslator(namespace?: string) {
    const t = (key: string) => lookup(namespace ? `${namespace}.${key}` : key);
    return Object.assign(t, { rich: t });
  }
  return {
    getTranslations: async (namespace?: string) => makeTranslator(namespace),
    getLocale: async () => "en",
    getMessages: async () => enMessages,
    Fragment,
  };
});

// Stub the detail rendering surface so we can focus on the cookie /
// header wiring here. The actual component is exhaustively covered by
// `components/work-items/work-item-detail.test.tsx`.
vi.mock("../../../components/work-items/work-item-detail", () => ({
  WorkItemDetail: ({
    initial,
    initialView,
    project,
    pipelinesByTask,
    agentReportsByTask,
  }: {
    initial: WorkItemDetailResponse;
    initialView?: string;
    project?: string;
    pipelinesByTask?: Record<string, GetPipelineResponse>;
    agentReportsByTask?: Record<
      string,
      Partial<Record<AgentReport["role"], AgentReport>>
    >;
  }) => (
    <div
      data-testid="detail"
      data-view={initialView}
      data-project={project}
      data-pipeline-count={Object.keys(pipelinesByTask ?? {}).length}
      data-agent-task-count={Object.keys(agentReportsByTask ?? {}).length}
    >
      {initial.workItem.workItemId}
    </div>
  ),
}));

function makeDetail(): WorkItemDetailResponse {
  const currentPlan = {
    planId: "tp_42",
    workItemId: "wi_42",
    version: 1,
    tasks: [],
    dependencies: [],
    operatorEdits: [],
    status: "accepted" as const,
  };
  return {
    workItem: {
      workItemId: "wi_42",
      sourceIssue: {
        projectId: "group/project",
        iid: 42,
        url: "https://gitlab.example.com/-/issues/42",
        title: "Auth migration",
      },
      title: "Auth migration",
      goal: "Migrate auth",
      acceptanceCriteria: ["AC1"],
      status: "running",
      taskIds: ["T1"],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    },
    plan: { current: currentPlan, history: [currentPlan] },
    tasks: [],
    runLinks: [],
  };
}

function makeDetailWithTask(): WorkItemDetailResponse {
  const detail = makeDetail();
  const task = {
    taskId: "T1",
    title: "T1",
    goal: "g",
    scope: "s",
    dependsOn: [],
    suggestedValidation: [],
    status: "ready" as const,
    runIds: [],
    riskLevel: "medium" as const,
  };
  return {
    ...detail,
    plan: {
      ...detail.plan,
      current: { ...detail.plan.current, tasks: [task] },
    },
    tasks: [task],
  };
}

describe("WorkItemDetailRoute (SSR)", () => {
  beforeEach(() => {
    cookieStore.clear();
    vi.mocked(getWorkItem).mockReset();
    vi.mocked(getPipeline).mockReset();
    vi.mocked(getAgentReport).mockReset();
  });

  it("attaches the persisted active project header so team-mode SSR does not return 400", async () => {
    cookieStore.set("issuepilot.workItems.activeProject", "platform-web");
    vi.mocked(getWorkItem).mockResolvedValue(makeDetail());

    const params = Promise.resolve({ id: "wi_42" });
    const page = await WorkItemDetailRoute({ params });
    render(page);

    expect(vi.mocked(getWorkItem)).toHaveBeenCalledTimes(1);
    const [calledId, calledOpts] = vi.mocked(getWorkItem).mock.calls[0]!;
    expect(calledId).toBe("wi_42");
    expect(calledOpts).toMatchObject({ project: "platform-web" });
    expect(screen.getByTestId("detail")).toHaveAttribute(
      "data-project",
      "platform-web",
    );
  });

  it("omits the project option when no cookie is present (single-mode behaviour preserved)", async () => {
    vi.mocked(getWorkItem).mockResolvedValue(makeDetail());

    const params = Promise.resolve({ id: "wi_42" });
    const page = await WorkItemDetailRoute({ params });
    render(page);

    const [calledId, calledOpts] = vi.mocked(getWorkItem).mock.calls[0]!;
    expect(calledId).toBe("wi_42");
    expect(calledOpts?.project).toBeUndefined();
  });

  it("preserves ?view=evidence as the initial detail view", async () => {
    vi.mocked(getWorkItem).mockResolvedValue(makeDetail());

    const params = Promise.resolve({ id: "wi_42" });
    const searchParams = Promise.resolve({ view: "evidence" });
    const page = await WorkItemDetailRoute({ params, searchParams });
    render(page);

    expect(screen.getByTestId("detail")).toHaveAttribute(
      "data-view",
      "evidence",
    );
  });

  it("soft-skips 404 pipeline data during SSR", async () => {
    vi.mocked(getWorkItem).mockResolvedValue(makeDetailWithTask());
    vi.mocked(getPipeline).mockRejectedValue(
      new ApiError("missing", 404, { code: "pipeline_run_not_found" }),
    );

    const page = await WorkItemDetailRoute({
      params: Promise.resolve({ id: "wi_42" }),
    });
    render(page);

    expect(screen.getByTestId("detail")).toHaveAttribute(
      "data-pipeline-count",
      "0",
    );
  });

  it("surfaces 503 pipeline wiring errors during SSR", async () => {
    vi.mocked(getWorkItem).mockResolvedValue(makeDetailWithTask());
    vi.mocked(getPipeline).mockRejectedValue(
      new ApiError("Pipeline service missing", 503, {
        code: "pipelines_unavailable",
      }),
    );

    const page = await WorkItemDetailRoute({
      params: Promise.resolve({ id: "wi_42" }),
    });
    render(page);

    expect(screen.getByText("Pipeline service missing")).toBeInTheDocument();
  });

  it("does not pass null pipelineRun responses into the V4.6 panel", async () => {
    vi.mocked(getWorkItem).mockResolvedValue(makeDetailWithTask());
    vi.mocked(getPipeline).mockResolvedValue({
      pipelineRun: null,
      agentReports: [],
      pendingRecipe: "full_pipeline",
      pendingRecipeSource: "workflow_default",
    });

    const page = await WorkItemDetailRoute({
      params: Promise.resolve({ id: "wi_42" }),
    });
    render(page);

    expect(screen.getByTestId("detail")).toHaveAttribute(
      "data-pipeline-count",
      "0",
    );
  });
});
