/**
 * Sora queue automation.
 *
 * Assumes Arc is launched with remote debugging enabled and the user is already
 * logged in to Sora in an open tab. The script attaches to the existing Arc
 * profile via CDP, watches the in-progress counter, and submits prompts to keep
 * three jobs running while the script is alive.
 *
 * Usage:
 *   1) Copy config.example.json to config.json and set selectors/tuning.
 *   2) Quit Arc if running, then start with:
 *      /Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=9222 --profile-directory=Market
 *   3) Open your Sora tab and stay logged in.
 *   4) In this directory: npm install
 *   5) Run: node sora_queue.js  (or npm run queue)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const loadConfigFile = () => {
  const cfgPath =
    process.env.CONFIG_FILE ||
    path.join(process.cwd(), "config.json"); // default local config
  if (!fs.existsSync(cfgPath)) return {};
  try {
    const txt = fs.readFileSync(cfgPath, "utf-8");
    return JSON.parse(txt);
  } catch (err) {
    console.error("Failed to parse config file", cfgPath, err);
    return {};
  }
};

const configFile = loadConfigFile();

const fromConfig = (key) => {
  if (process.env[key] !== undefined) return process.env[key];
  if (configFile[key] !== undefined) return configFile[key];
  return undefined;
};

const getNumber = (key, fallback) => {
  const raw = fromConfig(key);
  if (raw === undefined || raw === null || raw === "") return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
};

const getNumberAlias = (preferredKey, legacyKeys, fallback) => {
  const preferred = getNumber(preferredKey, undefined);
  if (preferred !== undefined) return preferred;
  for (const k of legacyKeys) {
    const v = getNumber(k, undefined);
    if (v !== undefined) return v;
  }
  return fallback;
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// --- CONFIG -----------------------------------------------------------------

// Remote debugging URL for Arc. Must match the port used when launching Arc.
const DEBUG_WS = fromConfig("DEBUG_WS") || "http://localhost:9222";

// Target number of in-flight generations to maintain (Sora caps at 3).
// Preferred: MAX_CONCURRENT. Legacy alias: TARGET_IN_FLIGHT.
const MAX_CONCURRENT = clamp(
  getNumberAlias("MAX_CONCURRENT", ["TARGET_IN_FLIGHT"], 3),
  1,
  3
);

// Polling interval (ms) when all slots are busy.
const POLL_MS = clamp(getNumber("POLL_MS", 5000), 250, 30000);

// Minimum gap between submissions to avoid rate limits.
const MIN_SUBMIT_INTERVAL_MS = clamp(
  getNumber("MIN_SUBMIT_INTERVAL_MS", 12000),
  500,
  60000
);

// Cooldown after 429 or similar errors.
const BACKOFF_429_MS = clamp(getNumber("BACKOFF_429_MS", 60000), 1000, 300000);

// How many times to run the entire prompts file.
// Example: 10 prompts + PROMPT_FILE_RUNS=2 => 20 total submissions.
// null => run forever.
// New name: PROMPT_FILE_RUNS. Legacy: MAX_SUBMITS.
const PROMPT_FILE_RUNS = getNumberAlias("PROMPT_FILE_RUNS", ["MAX_SUBMITS"], null);

// Logging
const LOG_FILE = fromConfig("LOG_FILE") || null;

// Tunables (timeouts / delays)
const FILL_TIMEOUT_MS = clamp(getNumber("FILL_TIMEOUT_MS", 30000), 1000, 120000);
const CLICK_TIMEOUT_MS = clamp(getNumber("CLICK_TIMEOUT_MS", 10000), 1000, 120000);
const VISIBLE_TIMEOUT_MS = clamp(getNumber("VISIBLE_TIMEOUT_MS", 5000), 500, 60000);
const GEN_REQUEST_TIMEOUT_MS = clamp(
  getNumber("GEN_REQUEST_TIMEOUT_MS", 20000),
  1000,
  120000
);
const GEN_RESPONSE_TIMEOUT_MS = clamp(
  getNumber("GEN_RESPONSE_TIMEOUT_MS", 20000),
  1000,
  120000
);
const AFTER_SUBMIT_WAIT_MS = clamp(
  getNumber("AFTER_SUBMIT_WAIT_MS", 2000),
  0,
  60000
);

// Drafts spinner in-progress detection can undercount (e.g., virtualization / not all tiles show spinners).
// This margin is added to the spinner count and capped at MAX_CONCURRENT to prevent oversubmitting.
const DRAFTS_SPINNER_SAFETY_MARGIN = clamp(
  getNumber("DRAFTS_SPINNER_SAFETY_MARGIN", 1),
  0,
  3
);

// In drafts mode, only check the most recent N tiles (default: MAX_CONCURRENT) to infer in-progress.
const DRAFTS_RECENT_CHECK_COUNT = clamp(
  getNumber("DRAFTS_RECENT_CHECK_COUNT", MAX_CONCURRENT),
  1,
  12
);

// Prompt parsing:
// - "full": if an item is an object, stringify the entire object and submit it.
// - "prompt": if an item is an object with {prompt: string}, submit only that field.
const PROMPT_OBJECT_MODE =
  (fromConfig("PROMPT_OBJECT_MODE") || "full").toString().toLowerCase();

// Logging setup
let logStream = null;
try {
  if (LOG_FILE) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  }
} catch (err) {
  console.error("Failed to open log file", LOG_FILE, err);
}

const originalLog = console.log;
const log = (...args) => {
  const msg = args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
  originalLog(msg);
  if (logStream) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logStream.write(line);
  }
};
console.log = log;

const renderProgressBar = (current, total, width = 20) => {
  if (!total || !Number.isFinite(total)) {
    return `[${"".padEnd(width, ".")}]`;
  }
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled).padEnd(width, ".")}]`;
};

// CSS selectors for Sora UI. Update these to real selectors from the page.
const selectors = {
  // Element that displays "X/3" or similar for in-progress jobs. If unavailable,
  // we fall back to checking whether the submit button is disabled.
  inProgressCount:
    fromConfig("SORA_IN_PROGRESS") || "CSS_SELECTOR_FOR_IN_PROGRESS_COUNT",
  // Prompt text area/input where the cinematic prompt goes.
  promptTextarea:
    fromConfig("SORA_PROMPT") ||
    "textarea.flex.w-full.rounded-md.text-sm.placeholder\\:text-token-text-secondary.focus-visible\\:outline-none.disabled\\:cursor-not-allowed.disabled\\:opacity-50.\\!overflow-x-hidden.tablet\\:max-h-\\[80vh\\].bg-transparent.px-2.py-3.max-tablet\\:flex-1",
  // Button that triggers submission (Create video).
  submitButton:
    fromConfig("SORA_SUBMIT") ||
    'button:has-text("Create video"), button:has(span.sr-only:has-text("Create video"))',
// Loading overlay/spinner shown while videos are in progress.
loadingOverlay:
    fromConfig("SORA_LOADING") ||
  "div.flex.h-full.w-full.items-center.justify-center.bg-token-bg-secondary svg.animate-spin",
  // Quick-pick buttons for aspect, resolution, duration, variations (selected by text).
  aspectChoice: fromConfig("SORA_ASPECT") || "",
  resolutionChoice: fromConfig("SORA_RESOLUTION") || "",
  durationChoice: fromConfig("SORA_DURATION") || "",
  variationsChoice: fromConfig("SORA_VARIATIONS") || "",
  variationsButton: fromConfig("SORA_VARIATIONS_BUTTON") || "",
  variationsOption: fromConfig("SORA_VARIATIONS_OPTION") || "",
  modeChoice: fromConfig("SORA_MODE") || "",
  // Alternate "drafts" UI (no activity counter): count in-progress tiles via spinner overlay.
  draftsUrl: fromConfig("SORA_DRAFTS_URL") || "https://sora.chatgpt.com/drafts",
  draftsInProgressSpinner:
    fromConfig("SORA_DRAFTS_IN_PROGRESS") ||
    "div.absolute.inset-0.grid.place-items-center",
  // Container that holds the drafts grid/virtualized list. Can be a CSS selector or an XPath selector (prefix with "xpath=").
  draftsGrid:
    fromConfig("SORA_DRAFTS_GRID") ||
    "xpath=/html/body/main/div[3]/div[1]/div/div/div/div/div[2]/div/div[1]",

  // New video settings menu (radix dropdown):
  // - A trigger button (typically a sliders/adjustments icon).
  // - Menu content uses [data-radix-menu-content][role="menu"] and items use role="menuitem*" / "menuitemradio".
  settingsTrigger: fromConfig("SORA_SETTINGS_TRIGGER") || "",
  settingsMenu: fromConfig("SORA_SETTINGS_MENU") || "div[data-radix-menu-content][role='menu']",
  orientationChoice: fromConfig("SORA_ORIENTATION") || "",
};

// Queue of prompts to submit (add more if desired). The script will cycle
// through this list repeatedly to keep 3 in-flight jobs while running.
const PROMPTS_FILE =
  fromConfig("PROMPTS_FILE") || path.join(process.cwd(), "prompts.json");

const DEFAULT_PROMPTS = [
  `10-second cinematic intro, inspired by Christopher Nolan’s moody style.
Shot on a Sony mirrorless camera with a 50mm f/1.8 prime lens, shallow depth of field, 16:9 horizontal, 24fps, dramatic contrast.

0–2s — Cold Night Setup
Interior, small Russian student room at night. Only a warm desk lamp and the cool blue glow of the PC monitor.
Camera: slow dolly-in on the back of a young Russian girl student sitting at her desk. 50mm f1.8, background softly blurred, light spilling over her shoulders. Subtle ticking sound, distant city noise.

2–4s — The Struggle
Over-the-shoulder shot, 50mm. We see a nearly blank essay page, blinking cursor, and a failed AI detector result in red (“AI detected”). Crumpled notes in Cyrillic around the keyboard.
She exhales in frustration, runs a hand through her hair. Slight handheld feel, like a Nolan character under pressure.

4–6s — The Turning Point
Close-up on her tired eyes, reflections of text on the screen.
Cut to a low-angle 50mm shot of the monitor as she copies stiff AI-generated text, then types into a search bar: “humanise AI text”.
She finds aihumaniser.pro. Subtle musical swell.

6–8s — The Transformation
Stylized UI macro-shot, 50mm at f1.8, super shallow depth of field.
She pastes the robotic text into the AI Humaniser interface and hits a glowing “Humanise” button.
The text gradually morphs into warm, fluid, human-sounding sentences.
Color grade shifts: shadows stay cool, but warm highlights bloom on her face and hands, like hope breaking through. Nolan-style contrast and controlled light.

8–10s — Resolution & Tagline
Medium shot from the side: she leans back, finally calm, faint smile.
On screen, the AI detector now shows green: “Human-like ✓”.
Camera orbits slowly around her at 50mm, background softly out of focus, desk lamp forming a beautiful bokeh.
As the camera settles, logo + URL fade in: AIHumaniser.pro
Final text on screen: “AIHumaniser.pro is the way to go.”

Overall mood: dark, focused, high contrast, controlled camera movement, minimal color palette, subtle ticking or low drone, cinematic film look.

Voiceover (pick one):
A) “Her words sounded fake. Every detector screamed AI. One search, one click… AI Humaniser took that cold, robotic text… and turned it into something truly human. AIHumaniser.pro is the way to go.”
B) “Stuck with an AI-sounding essay? Detectors flashing red? Paste it into AI Humaniser… and watch it become warm, natural, human. AIHumaniser.pro is the way to go.”`,
];

const normalizePromptItem = (item) => {
  if (item === null || item === undefined) return null;
  if (typeof item === "string") return item;
  if (typeof item === "object") {
    if (PROMPT_OBJECT_MODE === "prompt" && typeof item.prompt === "string") {
      return item.prompt;
    }
    // Default: treat the entire object as the prompt payload.
    return JSON.stringify(item, null, 2);
  }
  return String(item);
};

const loadPrompts = () => {
  if (fs.existsSync(PROMPTS_FILE)) {
    try {
      const raw = fs.readFileSync(PROMPTS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          console.warn(
            `Prompts file ${PROMPTS_FILE} array is empty; using defaults`
          );
          return DEFAULT_PROMPTS;
        }
        const out = parsed.map(normalizePromptItem).filter(Boolean);
        return out.length ? out : DEFAULT_PROMPTS;
      }
      // If a single object/string is provided, wrap it.
      if (typeof parsed === "string") return [parsed];
      if (parsed && typeof parsed === "object") {
        const one = normalizePromptItem(parsed);
        return one ? [one] : DEFAULT_PROMPTS;
      }

      console.warn(`Prompts file ${PROMPTS_FILE} not usable; using defaults`);
    } catch (err) {
      console.warn(`Failed to read prompts file ${PROMPTS_FILE}; using defaults`, err);
    }
  } else {
    console.warn(`Prompts file ${PROMPTS_FILE} not found; using defaults`);
  }
  return DEFAULT_PROMPTS;
};

// --- HELPERS ----------------------------------------------------------------

async function getSoraPage(browser) {
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      if (page.url().toLowerCase().includes("sora")) return page;
    }
  }
  return contexts[0]?.pages()[0];
}

async function getOrCreateDraftsPage(browser, submitPage) {
  const ctx = submitPage.context();
  for (const p of ctx.pages()) {
    if (p.url().toLowerCase().includes("/drafts")) return p;
  }
  const p = await ctx.newPage();
  try {
    await p.goto(selectors.draftsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch {}
  return p;
}

async function readInProgressFromActivityCounter(page) {
  // Prefer explicit counter if provided. Some pages can render multiple matching nodes;
  // we take the max numeric value found.
  if (selectors.inProgressCount) {
    const els = await page.$$(selectors.inProgressCount);
    if (els.length) {
      const nums = [];
      for (const el of els) {
        try {
          const txt = (await el.innerText()).trim();
          const num = parseInt(txt.replace(/\D+/g, ""), 10);
          if (Number.isFinite(num)) nums.push(num);
        } catch {}
      }
      if (nums.length) return Math.max(...nums);
    }
  }

  // If a loading overlay/spinner is present, assume capacity is full.
  if (selectors.loadingOverlay) {
    const loading = await page.$(selectors.loadingOverlay);
    if (loading) return MAX_CONCURRENT;
  }

  // If nothing found, treat as 0 (UI often hides the counter when it's zero).
  return 0;
}

async function readInProgressFromDraftsSpinner(draftsPage) {
  if (!selectors.draftsInProgressSpinner) return 0;
  try {
    // Each "in progress" tile shows a centered circular spinner overlay.
    // Only check the most recent N tiles in the drafts grid to avoid counting unrelated spinners.
    const grid = draftsPage.locator(selectors.draftsGrid).first();
    const hasGrid = (await grid.count()) > 0;
    if (hasGrid) {
      const tiles = grid.locator("[data-index]");
      const nTiles = await tiles.count();
      const toCheck = Math.min(DRAFTS_RECENT_CHECK_COUNT, nTiles);
      let inProg = 0;
      for (let i = 0; i < toCheck; i++) {
        const tile = tiles.nth(i);
        const spinning = await tile.locator(selectors.draftsInProgressSpinner).count();
        if (spinning > 0) inProg += 1;
      }
      return Math.min(MAX_CONCURRENT, inProg + DRAFTS_SPINNER_SAFETY_MARGIN);
    }

    // Fallback: count all spinners on the page (less accurate).
    const n = await draftsPage.locator(selectors.draftsInProgressSpinner).count();
    const base = Number.isFinite(n) ? Math.max(0, n) : 0;
    return Math.min(MAX_CONCURRENT, base + DRAFTS_SPINNER_SAFETY_MARGIN);
  } catch {
    // If drafts tab was closed / navigated, be conservative: treat as full.
    return MAX_CONCURRENT;
  }
}

async function detectInProgressStrategy(browser, submitPage) {
  // Strategy A (original): activity counter exists on this page.
  if (selectors.inProgressCount) {
    try {
      const cnt = await submitPage.locator(selectors.inProgressCount).count();
      if (cnt > 0) {
        console.log("Detected in-progress strategy: activity counter");
        return { mode: "activity", read: () => readInProgressFromActivityCounter(submitPage) };
      }
    } catch {}
  }

  // Strategy B (alternate): drafts page with per-tile spinner overlay.
  const draftsPage = await getOrCreateDraftsPage(browser, submitPage);
  console.log("Detected in-progress strategy: drafts spinner");
  return {
    mode: "drafts",
    draftsPage,
    read: async () => {
      // Re-open drafts tab if it got closed.
      let p = draftsPage;
      try {
        if (p.isClosed()) p = await getOrCreateDraftsPage(browser, submitPage);
      } catch {
        p = await getOrCreateDraftsPage(browser, submitPage);
      }
      return readInProgressFromDraftsSpinner(p);
    },
  };
}

async function isSubmitEnabled(page) {
  const submitSelectors = selectors.submitButton.split(',').map(s => s.trim());
  for (const selector of submitSelectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        const disabled =
          (await btn.getAttribute("disabled")) !== null ||
          (await btn.getAttribute("data-disabled")) === "true";
        if (!disabled) return true;
      }
    } catch {}
  }
  return false;
}

async function applyChoice(page, label) {
  if (!label) return;
  // If the choice label is already visible in the toolbar, don't click it (clicking
  // often opens a dropdown and can block submission).
  const already = await page.locator(`button:has-text("${label}")`).count();
  if (already > 0) return;
  console.log(`Choice "${label}" not found in toolbar; skipping auto-select.`);
}

async function applyVariationsChoice(page, label) {
  if (!label) return;
  // If already set, skip.
  const existing = await page.locator(`button:has-text("${label}")`).count();
  if (existing > 0) return;

  // Try to open the variations dropdown.
  const buttonSelector = selectors.variationsButton || `button:has-text("${label}")`;
  const btn = page.locator(buttonSelector).first();
  try {
    await btn.click({ timeout: VISIBLE_TIMEOUT_MS, force: true });
  } catch (err) {
    console.log(`Variations button not clickable (${buttonSelector}): ${err.message}`);
    return;
  }

  // Try to pick the desired option.
  const optionSelector =
    selectors.variationsOption || `[role="option"]:has-text("${label}")`;
  const opt = page.locator(optionSelector).filter({ hasText: label }).first();
  try {
    await opt.click({ timeout: VISIBLE_TIMEOUT_MS, force: true });
    return;
  } catch (err) {
    console.log(`Variations option not clickable (${optionSelector}): ${err.message}`);
  }

  // If still not set, try sending Enter after typing the label.
  try {
    await page.keyboard.insertText(label);
    await page.keyboard.press("Enter");
  } catch {}
}

const mapDurationLabel = (raw) => {
  if (!raw) return "";
  const s = String(raw).trim().toLowerCase();
  if (s === "10s" || s === "10 sec" || s === "10secs" || s === "10 seconds") return "10 seconds";
  if (s === "15s" || s === "15 sec" || s === "15secs" || s === "15 seconds") return "15 seconds";
  return raw;
};

const inferOrientation = (explicitOrientation, aspect) => {
  if (explicitOrientation) return explicitOrientation;
  const a = (aspect || "").toString().toLowerCase();
  // Common mapping: 9:16 => Portrait, 16:9 => Landscape
  if (a.includes("9:16") || a.includes("portrait")) return "Portrait";
  if (a.includes("16:9") || a.includes("landscape")) return "Landscape";
  return "";
};

async function openSettingsMenu(page) {
  const menu = page.locator(selectors.settingsMenu).first();
  try {
    if (await menu.isVisible()) return true;
  } catch {}

  // Strategy 1: user-provided selector.
  if (selectors.settingsTrigger) {
    try {
      await page.locator(selectors.settingsTrigger).first().click({ timeout: CLICK_TIMEOUT_MS, force: true });
      await menu.waitFor({ state: "visible", timeout: VISIBLE_TIMEOUT_MS });
      return true;
    } catch {}
  }

  // Strategy 2: auto-detect the trigger, but ONLY inside the composer area
  // (avoid sidebar buttons like Explore/Profile/etc).
  const composer = page
    .locator(selectors.promptTextarea)
    .first()
    .locator(
      "xpath=ancestor-or-self::*[.//span[contains(@class,'sr-only') and (contains(.,'Create video') or contains(.,'Create image') or contains(.,'Generate'))]][1]"
    );

  const candidates = composer
    .locator("button[aria-haspopup='menu'], button[aria-expanded]")
    .filter({ has: composer.locator("svg") });

  const n = await candidates.count();
  for (let i = 0; i < Math.min(n, 8); i++) {
    const btn = candidates.nth(i);
    try {
      // Skip disabled buttons.
      const disabled =
        (await btn.getAttribute("disabled")) !== null ||
        (await btn.getAttribute("data-disabled")) === "true";
      if (disabled) continue;
      await btn.click({ timeout: 1000, force: true });
      await menu.waitFor({ state: "visible", timeout: 1000 });
      return true;
    } catch {}
  }

  return false;
}

async function applyNewFormatVideoSettings(page) {
  // New format: only Orientation + Duration exist in a radix menu.
  // If we can't open/see the menu, return false and let legacy logic run.
  const opened = await openSettingsMenu(page);
  if (!opened) return false;

  const menu = page.locator(selectors.settingsMenu).first();
  const hasOrientationRow = (await menu.locator(":scope >> text=Orientation").count()) > 0;
  const hasDurationRow = (await menu.locator(":scope >> text=Duration").count()) > 0;
  if (!hasOrientationRow && !hasDurationRow) return false;

  // Orientation
  const desiredOrientation = inferOrientation(selectors.orientationChoice, selectors.aspectChoice);
  if (desiredOrientation) {
    try {
      await menu.locator("[role='menuitem']:has-text('Orientation'), [role='menuitemradio']:has-text('Orientation')").first()
        .click({ timeout: CLICK_TIMEOUT_MS, force: true });
    } catch {}
    try {
      await page
        .locator("[role='menuitemradio']")
        .filter({ hasText: desiredOrientation })
        .first()
        .click({ timeout: CLICK_TIMEOUT_MS, force: true });
      // Close menu/submenu
      await page.keyboard.press("Escape").catch(() => {});
    } catch {}
  }

  // Duration
  const desiredDuration = mapDurationLabel(selectors.durationChoice);
  if (desiredDuration) {
    try {
      await menu.locator("[role='menuitem']:has-text('Duration'), [role='menuitemradio']:has-text('Duration')").first()
        .click({ timeout: CLICK_TIMEOUT_MS, force: true });
    } catch {}
    try {
      await page
        .locator("[role='menuitemradio']")
        .filter({ hasText: desiredDuration })
        .first()
        .click({ timeout: CLICK_TIMEOUT_MS, force: true });
      await page.keyboard.press("Escape").catch(() => {});
    } catch {}
  }

  return true;
}

const isGenEndpoint = (url) =>
  (url.includes("backend/") &&
    (url.includes("video_gen") || url.includes("image_gen") || url.includes("gen")));

async function waitForGenRequest(page, timeoutMs) {
  return page
    .waitForRequest(
      (req) => isGenEndpoint(req.url()),
      { timeout: timeoutMs }
    )
    .catch(() => null);
}

async function submitPrompt(page, prompt) {
  // Ensure page is active and focused
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(200);
  
  // Activate the page by clicking on it to ensure it's interactive
  try {
    await page.evaluate(() => {
      window.focus();
      document.body.focus();
    });
  } catch {}
  
  // Wait for page to be in a ready state
  try {
    await page.waitForLoadState('networkidle').catch(() => {});
  } catch {}
  
  // Focus prompt area explicitly to avoid needing user interaction.
  try {
    const promptEl = await page.$(selectors.promptTextarea);
    if (promptEl) {
      await promptEl.click({ timeout: 5000, force: true });
      await page.waitForTimeout(200);
    }
  } catch {}
  
  await page.fill(selectors.promptTextarea, "", { timeout: FILL_TIMEOUT_MS });
  await page.fill(selectors.promptTextarea, prompt, { timeout: FILL_TIMEOUT_MS });
  
  // Wait a bit for the UI to register the text
  await page.waitForTimeout(500);
  
  // Dismiss any modal/overlay that might intercept clicks.
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  } catch {}
  
  // Apply quick-pick choices if configured.
  // Mode/setting pickers are dropdowns; we only act if they aren't already set.
  // Try the new "Orientation/Duration" menu format first; if not detected, fall back to legacy behavior.
  const appliedNewSettings = await applyNewFormatVideoSettings(page);
  if (!appliedNewSettings) {
    await applyChoice(page, selectors.modeChoice);
    await page.waitForTimeout(300);
    await applyChoice(page, selectors.aspectChoice);
    await page.waitForTimeout(300);
    await applyChoice(page, selectors.resolutionChoice);
    await page.waitForTimeout(300);
    await applyChoice(page, selectors.durationChoice);
    await page.waitForTimeout(300);
    await applyVariationsChoice(page, selectors.variationsChoice);
    await page.waitForTimeout(500);
  }

  // Close any popovers/dropdowns that might have opened.
  try {
    await page.keyboard.press("Escape");
  } catch {}

  // Try to get the submit button enabled: small loop to press Enter if needed.
  for (let i = 0; i < 5; i += 1) {
    const enabled = await isSubmitEnabled(page);
    if (enabled) break;
    try {
      await page.keyboard.press("Enter");
    } catch {}
    await page.waitForTimeout(500);
  }

  const enabledNow = await isSubmitEnabled(page);
  if (!enabledNow) {
    console.log("Submit still disabled after prompt + settings; skipping submit.");
    return false;
  }

  // Observe the backend request/response so we can verify a real submit happened.
  const reqPromise = waitForGenRequest(page, GEN_REQUEST_TIMEOUT_MS);

  // Try multiple selector strategies
  const submitSelectors = selectors.submitButton.split(',').map(s => s.trim());
  let clicked = false;
  
  for (const selector of submitSelectors) {
    try {
      const submit = page.locator(selector).first();
      await submit.waitFor({ state: "visible", timeout: VISIBLE_TIMEOUT_MS });
      const isEnabled = await isSubmitEnabled(page);
      if (!isEnabled) {
        console.log(`Submit button disabled, selector: ${selector}`);
        continue;
      }
      
      // Ensure page is focused before clicking
      await page.bringToFront().catch(() => {});
      await page.evaluate(() => {
        window.focus();
        document.body.focus();
      }).catch(() => {});
      await page.waitForTimeout(200);
      
      // Try normal click first
      try {
        await submit.click({ timeout: CLICK_TIMEOUT_MS });
        clicked = true;
        console.log(`Successfully clicked submit with selector: ${selector}`);
        break;
      } catch (err) {
        console.log(`Normal click failed for ${selector}, trying force click...`);
      }
      
      // Try force click
      try {
        await submit.click({ timeout: CLICK_TIMEOUT_MS, force: true });
        clicked = true;
        console.log(`Successfully force-clicked submit with selector: ${selector}`);
        break;
      } catch (err) {
        console.log(`Force click failed for ${selector}, trying JS click...`);
      }
      
      // Try JS click as last resort - with proper event dispatch
      try {
        const handle = await submit.elementHandle();
        if (handle) {
          await page.evaluate((el) => {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            // Dispatch proper mouse events to simulate real click
            const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
            const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
            const click = new MouseEvent('click', { bubbles: true, cancelable: true });
            el.dispatchEvent(mouseDown);
            el.dispatchEvent(mouseUp);
            el.dispatchEvent(click);
          }, handle);
          clicked = true;
          console.log(`Successfully JS-clicked submit with selector: ${selector}`);
          break;
        }
      } catch (err) {
        console.log(`JS click failed for ${selector}`);
      }
    } catch (err) {
      console.log(`Selector ${selector} not found or error: ${err.message}`);
      continue;
    }
  }
  
  if (!clicked) {
    throw new Error('Failed to click submit button with all strategies');
  }

  // If no gen request was observed, try keyboard submit (some UIs require it).
  let req = await reqPromise;
  if (!req) {
    for (const key of ["Meta+Enter", "Enter"]) {
      console.log(`No gen request observed. Trying keypress: ${key}`);
      const p = waitForGenRequest(page, 5000);
      try {
        await page.keyboard.press(key);
      } catch {}
      req = await p;
      if (req) break;
    }
  }

  if (!req) {
    console.log("No /backend/*gen POST request observed after submit attempts.");
    return false;
  }

  const reqUrl = req.url();
  console.log(`Gen request: ${req.method()} ${reqUrl}`);
  const res = await page
    .waitForResponse((r) => r.url() === reqUrl, { timeout: GEN_RESPONSE_TIMEOUT_MS })
    .catch(() => null);

  if (!res) {
    console.log("No response observed for gen request.");
    return false;
  }

  console.log(`Gen response: ${res.status()} ${res.url()}`);
  return res.status() === 200;
}

// --- MAIN -------------------------------------------------------------------

(async () => {
  console.log("Connecting to Arc via CDP:", DEBUG_WS);
  const browser = await chromium.connectOverCDP(DEBUG_WS);
  const page = await getSoraPage(browser);
  if (!page) throw new Error("No Sora page found; open it in Arc first.");
  const inProgressStrategy = await detectInProgressStrategy(browser, page);

  console.log("Connected. Maintaining queue…");

  // Track rate limits from network responses.
  let backoffUntil = 0;
  page.on("response", (res) => {
    try {
      const url = res.url();
      if (!isGenEndpoint(url)) return;
      const status = res.status();
      if (status === 429) {
        backoffUntil = Date.now() + BACKOFF_429_MS;
        console.log(
          `Received 429 from ${url}. Backing off for ${BACKOFF_429_MS / 1000}s`
        );
      }
    } catch (err) {
      // Swallow logging errors.
      console.error("response handler error", err);
    }
  });

  let idx = 0;
  let lastAttemptTs = 0;
  let submitCount = 0;
  const prompts = loadPrompts(); // initial load
  let promptsMtime = null;
  let cycle = 0;
  let promptIndex = 0;
  const totalPlannedSubmits =
    PROMPT_FILE_RUNS !== null && prompts.length
      ? prompts.length * PROMPT_FILE_RUNS
      : null;

  while (true) {
    const now = Date.now();

    // Reload prompts if file changed (best effort)
    try {
      const stat = fs.statSync(PROMPTS_FILE);
      const mtime = stat.mtimeMs;
      if (promptsMtime === null) promptsMtime = mtime;
      if (mtime !== promptsMtime) {
        const fresh = loadPrompts();
        if (fresh.length) {
          prompts.splice(0, prompts.length, ...fresh);
          promptsMtime = mtime;
          console.log("Prompts reloaded from file.");
          // Keep indices in range after reload.
          promptIndex = promptIndex % Math.max(prompts.length, 1);
        }
      }
    } catch {}
    if (now < backoffUntil) {
      const waitMs = Math.min(POLL_MS, backoffUntil - now);
      console.log(`In backoff for ${waitMs}ms due to prior 429`);
      await page.waitForTimeout(waitMs);
      continue;
    }

    if (now - lastAttemptTs < MIN_SUBMIT_INTERVAL_MS) {
      await page.waitForTimeout(POLL_MS);
      continue;
    }

    const count = await inProgressStrategy.read();

    if (count >= MAX_CONCURRENT) {
      await page.waitForTimeout(POLL_MS);
      continue;
    }

    if (!prompts.length) {
      console.log("No prompts loaded; waiting…");
      await page.waitForTimeout(POLL_MS);
      continue;
    }

    // Stop condition: after PROMPT_FILE_RUNS full passes through the prompts list.
    if (PROMPT_FILE_RUNS !== null && cycle >= PROMPT_FILE_RUNS) {
      console.log(`Reached PROMPT_FILE_RUNS=${PROMPT_FILE_RUNS}. Exiting.`);
      break;
    }

    const prompt = prompts[promptIndex];
    const progressBar = renderProgressBar(
      submitCount,
      totalPlannedSubmits ?? undefined
    );
    console.log(
      `${progressBar} In progress: ${count}/${MAX_CONCURRENT} | prompt ${promptIndex + 1}/${prompts.length} | run ${cycle + 1}/${PROMPT_FILE_RUNS ?? "∞"} | submitted ${submitCount}/${totalPlannedSubmits ?? "∞"}`
    );
    console.log("Submitting next prompt…");
    const ok = await submitPrompt(page, prompt);
    lastAttemptTs = Date.now();
    console.log(`Submit result: ${ok ? "OK" : "NOT OK"}`);
    if (ok) {
      submitCount += 1;
      promptIndex += 1;
      if (promptIndex >= prompts.length) {
        promptIndex = 0;
        cycle += 1;
        console.log(`Completed a full prompts pass. cycle=${cycle}`);
        // If we just completed the final configured run, exit immediately (don't wait
        // for the in-progress counter to drop).
        if (PROMPT_FILE_RUNS !== null && cycle >= PROMPT_FILE_RUNS) {
          console.log(`Reached PROMPT_FILE_RUNS=${PROMPT_FILE_RUNS}. Exiting.`);
          break;
        }
      }
      // Give UI time to register submission before rechecking.
      if (AFTER_SUBMIT_WAIT_MS) await page.waitForTimeout(AFTER_SUBMIT_WAIT_MS);
    } else {
      // If not confirmed, don't hammer.
      await page.waitForTimeout(Math.max(POLL_MS, 2000));
    }
  }
  // Clean shutdown: disconnect from CDP so node can exit.
  console.log("Shutting down...");
  process.exitCode = process.exitCode || 0;
  
  // Failsafe: force exit after 3 seconds no matter what
  const forceExitTimer = setTimeout(() => {
    console.log("Force exiting after timeout...");
    process.exit(process.exitCode || 0);
  }, 3000);
  
  if (logStream) {
    try {
      logStream.end();
    } catch {}
  }
  // Close browser with timeout to prevent hanging
  try {
    await Promise.race([
      browser.close(),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  } catch {}
  // Clear the failsafe timer since we're exiting normally
  clearTimeout(forceExitTimer);
  // Force exit immediately - don't wait for any async cleanup
  console.log("Exiting process.");
  process.exit(process.exitCode);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  
  // Failsafe: force exit after 2 seconds on error
  const forceExitTimer = setTimeout(() => {
    console.error("Force exiting after error timeout...");
    process.exit(1);
  }, 2000);
  
  if (logStream) {
    try {
      logStream.end();
    } catch {}
  }
  clearTimeout(forceExitTimer);
  process.exit(1);
});

