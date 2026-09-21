/**
 * Launching Chromium for the browser-driven checks.
 *
 * Normally Playwright manages its own browser build and this is a thin pass-through: run
 * `npx playwright install chromium` once and everything works. Some environments ship a
 * system Chromium and block browser downloads, so `CHROMIUM_EXECUTABLE` points the checks at
 * an existing binary instead. It is opt-in and unset by default, so it cannot quietly mask a
 * genuine version mismatch on a normal machine.
 */
import { chromium } from "playwright";

export function launchChromium(options = {}) {
  const executablePath = process.env.CHROMIUM_EXECUTABLE || undefined;
  return chromium.launch({ ...options, ...(executablePath ? { executablePath } : {}) });
}
