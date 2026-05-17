"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";

import { LocaleToggle } from "./locale-toggle";
import { ThemeToggle } from "./theme-toggle";

interface NavItem {
  href: string;
  labelKey: "commandCenter" | "reports" | "workItems";
  icon: React.ReactNode;
  match: (pathname: string) => boolean;
}

function HomeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M5.5 10.5V20h13v-9.5" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}

function WorkItemsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="7" height="7" rx="1.4" />
      <rect x="13" y="4" width="7" height="7" rx="1.4" />
      <rect x="4" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="13" width="7" height="7" rx="1.4" />
    </svg>
  );
}

function ReportsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 21V8m6 13V4m6 17v-9" />
      <path d="M3 21h18" />
    </svg>
  );
}

const NAV: NavItem[] = [
  {
    href: "/",
    labelKey: "commandCenter",
    icon: <HomeIcon />,
    match: (p) => p === "/" || p.startsWith("/runs"),
  },
  {
    href: "/work-items",
    labelKey: "workItems",
    icon: <WorkItemsIcon />,
    match: (p) => p.startsWith("/work-items"),
  },
  {
    href: "/reports",
    labelKey: "reports",
    icon: <ReportsIcon />,
    match: (p) => p.startsWith("/reports"),
  },
];

/**
 * Horizontal top bar shell.
 *
 * Replaces the previous 232px left sidebar with a single sticky strip
 * so the main content keeps the full viewport width — important for
 * the kanban view (`run-board-view`) which needs ≥960px to render its
 * six lifecycle columns without an awkward x-overflow.
 *
 * Layout:
 *   [logo + brand] [primary nav] · · · [locale | theme | mode tag]
 *
 * The locale + theme toggles are user preferences, not navigation, so
 * they live in a right-aligned tools cluster — the destination most
 * SaaS dashboards (Linear, Vercel, Sentry) put them in.
 */
export function TopBar() {
  const pathname = usePathname() ?? "/";
  const t = useTranslations("nav");

  return (
    <header
      className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80"
      aria-label={t("primary")}
    >
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-4 lg:h-16 lg:gap-6 lg:px-6">
        <BrandBlock t={t} />

        <nav
          aria-label={t("primary")}
          className="-mx-1 flex flex-1 items-center gap-1 overflow-x-auto"
        >
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors duration-150 ease-swiss-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-surface-2 text-fg"
                    : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    active ? "text-fg" : "text-fg-subtle group-hover:text-fg",
                  )}
                >
                  {item.icon}
                </span>
                <span>{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <LocaleToggle />
          <ThemeToggle />
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle xl:inline">
            {t("modeTag")}
          </span>
        </div>
      </div>
    </header>
  );
}

function BrandBlock({ t }: { t: (key: "brand" | "shellTitle") => string }) {
  return (
    <Link
      href="/"
      className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Logo />
      <span className="hidden flex-col leading-tight md:flex">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          {t("brand")}
        </span>
        <span className="text-sm font-semibold tracking-tight text-fg">
          {t("shellTitle")}
        </span>
      </span>
    </Link>
  );
}

function Logo() {
  return (
    <span
      aria-hidden="true"
      className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-fg shadow-1"
    >
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 6h16M4 12h10M4 18h16" />
      </svg>
    </span>
  );
}
