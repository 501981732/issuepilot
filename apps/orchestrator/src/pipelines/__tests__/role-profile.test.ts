import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  ReviewerRoleConfig,
  CoderRoleConfig,
} from "@issuepilot/shared-contracts";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  RoleProfileInvalidError,
  buildRoleProfile,
  renderPromptTemplate,
} from "../role-profile.js";

const reviewerRole = (over: Partial<ReviewerRoleConfig> = {}): ReviewerRoleConfig => ({
  role: "reviewer",
  promptTemplate: "<filled-in-test>",
  promptTemplateHash: "abc123",
  sandbox: "danger-full-access",
  tools: [{ name: "run.command", allow: ["pnpm test"] }],
  timeoutSeconds: 1800,
  tokenScopeRequirements: ["api", "read_repository"],
  publishToMr: true,
  severityThreshold: "medium",
  maxInlineComments: 25,
  ...over,
});

const coderRole = (over: Partial<CoderRoleConfig> = {}): CoderRoleConfig => ({
  role: "coder",
  promptTemplate: "<filled-in-test>",
  promptTemplateHash: "abc123",
  sandbox: "danger-full-access",
  tools: [{ name: "run.command", allow: ["pnpm test", "git push"] }],
  timeoutSeconds: 3600,
  tokenScopeRequirements: ["api"],
  ...over,
});

describe("renderPromptTemplate", () => {
  it("替换 {{var}} 占位（支持 work_item / task / extra 上下文）", () => {
    const out = renderPromptTemplate(
      "Hello {{work_item.iid}} #{{task.id}} {{extra.foo}}",
      {
        workItem: { id: "wi_1", iid: 42, title: "demo" },
        task: { id: "t_1", title: "do" },
        extra: { foo: "bar" },
      },
    );
    expect(out).toBe("Hello 42 #t_1 bar");
  });

  it("未提供的占位保留 [missing] 标记，不抛错（spec §10 留 placeholder 风格）", () => {
    const out = renderPromptTemplate("X={{work_item.unknown}}", {
      workItem: { id: "wi_1", iid: 1, title: "t" },
      task: { id: "t_1", title: "do" },
    });
    expect(out).toContain("[missing: work_item.unknown]");
  });

  it("HTML-safe，不做 escape，但保留 Markdown 原文", () => {
    const out = renderPromptTemplate("`{{task.title}}`", {
      workItem: { id: "wi_1", iid: 1, title: "t" },
      task: { id: "t_1", title: "<b>raw</b>" },
    });
    expect(out).toBe("`<b>raw</b>`");
  });
});

describe("buildRoleProfile", () => {
  let tmpRoot: string;
  let reviewerPromptPath: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "ip-role-profile-"));
    await mkdir(join(tmpRoot, "prompts"), { recursive: true });
    reviewerPromptPath = join(tmpRoot, "prompts", "reviewer.md");
    await writeFile(
      reviewerPromptPath,
      "Review {{work_item.iid}} task {{task.title}}",
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("返回渲染后的 prompt + sandbox + tools + hash + timeout + tokenScopeRequirements", async () => {
    const cfg = reviewerRole({ promptTemplate: reviewerPromptPath });
    const profile = await buildRoleProfile({
      role: cfg,
      workItem: { id: "wi_42", iid: 42, title: "demo" },
      task: { id: "t_99", title: "Fix bug" },
    });
    expect(profile.role).toBe("reviewer");
    expect(profile.prompt).toBe("Review 42 task Fix bug");
    expect(profile.sandbox).toBe("danger-full-access");
    expect(profile.toolAllow).toEqual([
      { name: "run.command", allow: ["pnpm test"] },
    ]);
    expect(profile.timeoutSeconds).toBe(1800);
    expect(profile.tokenScopeRequirements).toEqual(["api", "read_repository"]);
    expect(profile.promptTemplateHash).toBe("abc123");
    expect(profile.roleProfileId).toMatch(/^reviewer@/);
  });

  it("reviewer 配置传入 publishToMr / severityThreshold / maxInlineComments 时透传", async () => {
    const cfg = reviewerRole({
      promptTemplate: reviewerPromptPath,
      publishToMr: false,
      severityThreshold: "high",
      maxInlineComments: 10,
    });
    const profile = await buildRoleProfile({
      role: cfg,
      workItem: { id: "wi_1", iid: 1, title: "" },
      task: { id: "t_1", title: "" },
    });
    expect(profile.role).toBe("reviewer");
    expect(profile.publishToMr).toBe(false);
    expect(profile.severityThreshold).toBe("high");
    expect(profile.maxInlineComments).toBe(10);
  });

  it("缺 prompt 路径 / 不存在的文件 → RoleProfileInvalidError", async () => {
    const cfg = coderRole({ promptTemplate: join(tmpRoot, "nope.md") });
    await expect(
      buildRoleProfile({
        role: cfg,
        workItem: { id: "wi_1", iid: 1, title: "" },
        task: { id: "t_1", title: "" },
      }),
    ).rejects.toBeInstanceOf(RoleProfileInvalidError);
  });

  it("promptTemplateHash 缺失（resolve 未跑）→ RoleProfileInvalidError", async () => {
    const cfg = reviewerRole({
      promptTemplate: reviewerPromptPath,
      promptTemplateHash: undefined,
    });
    await expect(
      buildRoleProfile({
        role: cfg,
        workItem: { id: "wi_1", iid: 1, title: "" },
        task: { id: "t_1", title: "" },
      }),
    ).rejects.toBeInstanceOf(RoleProfileInvalidError);
  });

  it("缺失的占位变量产生稳定 [missing: ...] 标记，仍可生成 profile", async () => {
    const promptWithMissing = join(tmpRoot, "with-missing.md");
    await writeFile(
      promptWithMissing,
      "X={{extra.unknown}} Y={{task.title}}",
      "utf8",
    );
    const cfg = reviewerRole({ promptTemplate: promptWithMissing });
    const profile = await buildRoleProfile({
      role: cfg,
      workItem: { id: "wi_1", iid: 1, title: "" },
      task: { id: "t_1", title: "T" },
    });
    expect(profile.prompt).toBe("X=[missing: extra.unknown] Y=T");
  });
});
