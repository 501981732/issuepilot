import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  type Locale,
  isLocale,
} from "./locales";

/**
 * Server-side locale resolver. Reads the cookie set by LocaleToggle and
 * falls back to the default locale when missing/invalid. Cookie-based
 * (instead of route-based) so URLs stay stable across language flips.
 */
export default getRequestConfig(async () => {
  const store = cookies();
  const cookieValue = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(cookieValue) ? cookieValue : DEFAULT_LOCALE;

  const messages = (
    locale === "zh"
      ? await import("./messages/zh.json")
      : await import("./messages/en.json")
  ).default;

  return {
    locale,
    messages,
  };
});
