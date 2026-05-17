// @vitest-environment jsdom
import type { WorkItemsListResponse } from "@issuepilot/shared-contracts";
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "../../i18n/messages/en.json";
import { renderWithIntl as render } from "../../test/intl";

import WorkItemsRoute from "./page";
import { listWorkItems, setActiveWorkItemsProject } from "../../lib/api";

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/api")
  >("../../lib/api");
  return {
    ...actual,
    listWorkItems: vi.fn(),
  };
});

vi.mock("../../components/work-items/work-items-list", () => ({
  WorkItemsList: ({ workItems }: { workItems: unknown[] }) => (
    <div data-testid="work-items-list">{workItems.length}</div>
  ),
}));

// next-intl is consumed via `useTranslations` (client hook). The shared
// `renderWithIntl` helper already provides an English messages catalog,
// so we just have to ensure the namespace resolves.
const _msgKey = "workItems";
void _msgKey;
void enMessages;

const PROJECT_KEY = "issuepilot.workItems.activeProject";

function makeResponse(): WorkItemsListResponse {
  return {
    workItems: [],
    counters: {
      planning: 0,
      ready: 0,
      running: 0,
      partial: 0,
      completed: 0,
      blocked: 0,
    },
  };
}

describe("WorkItemsRoute (CSR)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setActiveWorkItemsProject(null);
    vi.mocked(listWorkItems).mockReset();
  });

  // V4.2 review I3: the page used to call `listWorkItems()` without
  // first syncing the localStorage-persisted active project into the
  // API client's module-level state. ProjectSwitcher's own hydration
  // effect could race with this first fetch, so on a cold load the
  // initial request was missing `x-issuepilot-project` and the
  // orchestrator returned 400. Lock in the synchronous hydrate-before-
  // fetch contract: the first listWorkItems call must already carry
  // the project option.
  it("hydrates the persisted project before the first listWorkItems call", async () => {
    window.localStorage.setItem(PROJECT_KEY, "platform-web");
    vi.mocked(listWorkItems).mockResolvedValue(makeResponse());

    render(<WorkItemsRoute />);

    await waitFor(() => {
      expect(vi.mocked(listWorkItems)).toHaveBeenCalledTimes(1);
    });
    const [calledOpts] = vi.mocked(listWorkItems).mock.calls[0]!;
    expect(calledOpts).toMatchObject({ project: "platform-web" });
  });

  it("omits the project option when nothing is persisted (single-mode behaviour preserved)", async () => {
    vi.mocked(listWorkItems).mockResolvedValue(makeResponse());

    render(<WorkItemsRoute />);

    await waitFor(() => {
      expect(vi.mocked(listWorkItems)).toHaveBeenCalledTimes(1);
    });
    const [calledOpts] = vi.mocked(listWorkItems).mock.calls[0]!;
    expect(calledOpts?.project).toBeUndefined();
  });
});
