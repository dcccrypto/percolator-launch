/**
 * Pure builder for the TradingView widget constructor options, so the
 * featureset choices (desktop vs. phone vs. full-screen sheet) are testable
 * without the library.
 */
import type { ChartTheme } from "@/hooks/useChartTheme";
import { TV_CUSTOM_CSS_URL, TV_LIBRARY_PATH } from "./config";
import { chartOverrides, customThemes, studiesOverrides, type SiteThemeName } from "./theme";
import type { TvDatafeed, TvResolution, TvSaveLoadAdapter, TvSettingsAdapter, TvWidgetOptions } from "./types";

/**
 * - desktop:    the full TradingView UI (header, drawing toolbar, bottom bar).
 * - compact:    phones. The library's minimum comfortable size is 500x500, so the
 *               toolbars are hidden; resolution comes from our own pill row and
 *               the "expand" button opens the full-screen sheet.
 * - fullscreen: the phone full-screen sheet — full toolbars, touch drawing.
 */
export type TvLayoutMode = "desktop" | "compact" | "fullscreen";

export const DEFAULT_INTERVAL: TvResolution = "1D";

const BASE_ENABLED = [
  // The iframe loads /charting_library/sameorigin.html (frame-src 'self') instead
  // of a blob: URL, so the page CSP needs no blob: frames.
  "iframe_loading_same_origin",
  "study_templates",
];

const BASE_DISABLED = [
  // Changing symbol inside the chart would desync the page (order ticket,
  // positions) from the market; markets are switched via the page's own picker.
  "header_symbol_search",
  "symbol_search_hot_key",
  "header_compare",
  // Layouts auto-save per market (lib/tv/saveLoadAdapter.ts); no manual save menu.
  "header_saveload",
  // Settings go through settings_adapter (perc:tv:settings) instead.
  "use_localstorage_for_settings",
];

const COMPACT_DISABLED = [
  "header_widget",
  "left_toolbar",
  "timeframes_toolbar",
  "control_bar",
  "edit_buttons_in_legend",
  "border_around_the_chart",
  "header_screenshot",
  "header_fullscreen_button",
];

export function featuresets(mode: TvLayoutMode): { enabled: string[]; disabled: string[] } {
  switch (mode) {
    case "desktop":
      return { enabled: [...BASE_ENABLED], disabled: [...BASE_DISABLED] };
    case "compact":
      return { enabled: [...BASE_ENABLED, "adaptive_logo"], disabled: [...BASE_DISABLED, ...COMPACT_DISABLED] };
    case "fullscreen":
      return {
        enabled: [...BASE_ENABLED, "show_zoom_and_move_buttons_on_touch"],
        disabled: [...BASE_DISABLED, "header_fullscreen_button"],
      };
  }
}

/** Common IANA zones; anything else charts in UTC (users can change it in the chart settings). */
const KNOWN_TIMEZONES = new Set([
  "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
  "America/Argentina/Buenos_Aires", "America/Bogota", "America/Chicago", "America/Los_Angeles",
  "America/Mexico_City", "America/New_York", "America/Phoenix", "America/Sao_Paulo",
  "America/Toronto", "America/Vancouver",
  "Asia/Bangkok", "Asia/Dubai", "Asia/Ho_Chi_Minh", "Asia/Hong_Kong", "Asia/Jakarta",
  "Asia/Kolkata", "Asia/Manila", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore",
  "Asia/Taipei", "Asia/Tokyo",
  "Australia/Sydney", "Australia/Perth",
  "Europe/Amsterdam", "Europe/Berlin", "Europe/Dublin", "Europe/Istanbul", "Europe/Lisbon",
  "Europe/London", "Europe/Madrid", "Europe/Moscow", "Europe/Paris", "Europe/Rome",
  "Europe/Stockholm", "Europe/Warsaw", "Europe/Zurich",
  "Pacific/Auckland", "Pacific/Honolulu",
]);

export function chartTimezone(ianaZone: string | undefined): string {
  return ianaZone && KNOWN_TIMEZONES.has(ianaZone) ? ianaZone : "Etc/UTC";
}

export interface BuildOptionsInput {
  container: HTMLElement;
  datafeed: TvDatafeed;
  slab: string;
  interval: TvResolution;
  themeName: SiteThemeName;
  dark: ChartTheme;
  light: ChartTheme;
  mode: TvLayoutMode;
  saveLoad: TvSaveLoadAdapter;
  settings: TvSettingsAdapter;
  savedData: object | null;
  timezone: string;
  debug: boolean;
}

export function buildWidgetOptions(i: BuildOptionsInput): TvWidgetOptions {
  const active = i.themeName === "dark" ? i.dark : i.light;
  const fs = featuresets(i.mode);
  return {
    container: i.container,
    library_path: TV_LIBRARY_PATH,
    datafeed: i.datafeed,
    symbol: i.slab,
    interval: i.interval,
    locale: "en",
    timezone: i.timezone,
    autosize: true,
    theme: i.themeName,
    custom_themes: customThemes(i.dark, i.light),
    overrides: chartOverrides(active),
    studies_overrides: studiesOverrides(active),
    custom_css_url: TV_CUSTOM_CSS_URL,
    loading_screen: { backgroundColor: active.bg, foregroundColor: "#9945FF" },
    toolbar_bg: active.bg,
    enabled_features: fs.enabled,
    disabled_features: fs.disabled,
    favorites: { intervals: ["1", "5", "15", "60", "240", "1D"] },
    time_frames: [
      { text: "1d", resolution: "5", description: "1 day" },
      { text: "5d", resolution: "15", description: "5 days" },
      { text: "1m", resolution: "60", description: "1 month" },
      { text: "3m", resolution: "240", description: "3 months" },
      { text: "1y", resolution: "1D", description: "1 year" },
    ],
    save_load_adapter: i.saveLoad,
    settings_adapter: i.settings,
    ...(i.savedData ? { saved_data: i.savedData } : {}),
    auto_save_delay: 2,
    debug: i.debug,
  };
}
