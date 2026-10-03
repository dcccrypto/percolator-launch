/**
 * Minimal, hand-written type declarations for the parts of the TradingView
 * Advanced Charts widget API this app calls.
 *
 * The library's own typings are licensed with the library and must NOT be
 * committed to this public repo, so this file declares only the subset we
 * use, in our own words, and nothing else. Members are added here when the
 * code starts calling them — keep it small.
 */

/** A resolution such as "1", "15", "60", "1D", "1W". */
export type TvResolution = string;

export interface TvBar {
  /** Milliseconds since epoch (UTC), bar open time. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface TvHistoryMeta {
  noData?: boolean;
  /** Seconds since epoch of the next older bar, when there is a gap. */
  nextTime?: number | null;
}

export interface TvPeriodParams {
  /** Seconds since epoch (inclusive). */
  from: number;
  /** Seconds since epoch (exclusive). */
  to: number;
  countBack: number;
  firstDataRequest: boolean;
}

export interface TvSymbolInfo {
  name: string;
  ticker?: string;
  description: string;
  type: string;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  format: "price" | "volume";
  pricescale: number;
  minmov: number;
  has_intraday?: boolean;
  intraday_multipliers?: string[];
  has_daily?: boolean;
  daily_multipliers?: string[];
  has_weekly_and_monthly?: boolean;
  supported_resolutions?: TvResolution[];
  volume_precision?: number;
  visible_plots_set?: "ohlcv" | "ohlc" | "c";
  data_status?: "streaming" | "endofday" | "delayed_streaming";
  logo_urls?: string[];
}

export interface TvSearchResult {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker?: string;
  type: string;
}

export interface TvDatafeedConfiguration {
  supported_resolutions?: TvResolution[];
  exchanges?: { value: string; name: string; desc: string }[];
  symbols_types?: { name: string; value: string }[];
  supports_marks?: boolean;
  supports_timescale_marks?: boolean;
  supports_time?: boolean;
}

/** The JS Datafeed API object handed to the widget constructor. */
export interface TvDatafeed {
  onReady(cb: (config: TvDatafeedConfiguration) => void): void;
  searchSymbols(
    userInput: string,
    exchange: string,
    symbolType: string,
    onResult: (items: TvSearchResult[]) => void,
  ): void;
  resolveSymbol(
    symbolName: string,
    onResolve: (info: TvSymbolInfo) => void,
    onError: (reason: string) => void,
  ): void;
  getBars(
    symbolInfo: TvSymbolInfo,
    resolution: TvResolution,
    period: TvPeriodParams,
    onResult: (bars: TvBar[], meta?: TvHistoryMeta) => void,
    onError: (reason: string) => void,
  ): void;
  subscribeBars(
    symbolInfo: TvSymbolInfo,
    resolution: TvResolution,
    onTick: (bar: TvBar) => void,
    listenerGuid: string,
    onResetCacheNeeded: () => void,
  ): void;
  unsubscribeBars(listenerGuid: string): void;
}

/** A point on the chart: time in SECONDS since epoch, plus price. */
export interface TvShapePoint {
  time: number;
  price?: number;
}

export interface TvCreateShapeOptions {
  shape?: string;
  text?: string;
  lock?: boolean;
  disableSelection?: boolean;
  disableSave?: boolean;
  disableUndo?: boolean;
  showInObjectsTree?: boolean;
  zOrder?: "top" | "bottom";
  overrides?: Record<string, string | number | boolean>;
}

/** A drawing on the chart (what getShapeById returns). */
export interface TvShapeApi {
  setPoints(points: TvShapePoint[]): void;
  setProperties(props: Record<string, string | number | boolean>): void;
}

export type TvEntityId = string;

/** The subset of the per-chart API we call. */
export interface TvChartApi {
  symbol(): string;
  resolution(): TvResolution;
  setSymbol(symbol: string): Promise<boolean>;
  setResolution(resolution: TvResolution): Promise<boolean>;
  setChartType(type: number): Promise<void>;
  resetData(): void;
  createShape(point: TvShapePoint, options: TvCreateShapeOptions): Promise<TvEntityId>;
  createMultipointShape(points: TvShapePoint[], options: TvCreateShapeOptions): Promise<TvEntityId>;
  createStudy(
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Record<string, string | number | boolean>,
    overrides?: Record<string, string | number | boolean>,
  ): Promise<TvEntityId | null>;
  getShapeById(id: TvEntityId): TvShapeApi;
  removeEntity(id: TvEntityId): void;
  getAllShapes(): { id: TvEntityId; name: string }[];
  getAllStudies(): { id: TvEntityId; name: string }[];
  applyOverrides(overrides: Record<string, string | number | boolean>): void;
  onIntervalChanged(): {
    subscribe(obj: object | null, cb: (interval: TvResolution) => void): void;
    unsubscribe(obj: object | null, cb: (interval: TvResolution) => void): void;
  };
}

/** The subset of the widget API we call. */
export interface TvWidget {
  chartReady(): Promise<void>;
  headerReady(): Promise<void>;
  activeChart(): TvChartApi;
  changeTheme(theme: "light" | "dark"): Promise<void>;
  applyOverrides(overrides: Record<string, string | number | boolean>): void;
  save(): Promise<object>;
  subscribe(event: string, cb: (...args: unknown[]) => void): void;
  unsubscribe(event: string, cb: (...args: unknown[]) => void): void;
  remove(): void;
}

/** Chart metadata as the save/load adapter stores it. */
export interface TvChartRecord {
  id: string;
  name: string;
  symbol: string;
  resolution: TvResolution;
  timestamp: number;
}

export interface TvChartData {
  id?: string | number;
  name: string;
  symbol: string;
  resolution: TvResolution;
  content: string;
  timestamp: number;
}

export interface TvStudyTemplateMeta {
  name: string;
}

export interface TvStudyTemplateData {
  name: string;
  content: string;
}

/**
 * Save/load adapter (charts, study templates, drawing templates, chart
 * templates). All methods are promise-based.
 */
export interface TvSaveLoadAdapter {
  getAllCharts(): Promise<TvChartRecord[]>;
  removeChart(id: string | number): Promise<void>;
  saveChart(chart: TvChartData): Promise<string>;
  getChartContent(id: string | number): Promise<string>;
  getAllStudyTemplates(): Promise<TvStudyTemplateMeta[]>;
  removeStudyTemplate(meta: TvStudyTemplateMeta): Promise<void>;
  saveStudyTemplate(data: TvStudyTemplateData): Promise<void>;
  getStudyTemplateContent(meta: TvStudyTemplateMeta): Promise<string>;
  getDrawingTemplates(toolName: string): Promise<string[]>;
  loadDrawingTemplate(toolName: string, templateName: string): Promise<string>;
  removeDrawingTemplate(toolName: string, templateName: string): Promise<void>;
  saveDrawingTemplate(toolName: string, templateName: string, content: string): Promise<void>;
  getChartTemplateContent(templateName: string): Promise<{ content?: object }>;
  getAllChartTemplates(): Promise<string[]>;
  saveChartTemplate(name: string, content: object): Promise<void>;
  removeChartTemplate(name: string): Promise<void>;
}

export interface TvSettingsAdapter {
  initialSettings?: Record<string, string>;
  setValue(key: string, value: string): void;
  removeValue(key: string): void;
}

/** 19 shades, lightest (50) to darkest (950). */
export type TvColorRamp = [
  string, string, string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string, string,
];

export interface TvThemeColors {
  color1: TvColorRamp;
  color2: TvColorRamp;
  color3: TvColorRamp;
  color4: TvColorRamp;
  color5: TvColorRamp;
  color6: TvColorRamp;
  color7: TvColorRamp;
  white: string;
  black: string;
}

/** The constructor options we pass. */
export interface TvWidgetOptions {
  container: HTMLElement;
  library_path: string;
  datafeed: TvDatafeed;
  symbol: string;
  interval: TvResolution;
  locale: string;
  timezone?: string;
  autosize: boolean;
  theme: "light" | "dark";
  custom_themes?: { light: TvThemeColors; dark: TvThemeColors };
  overrides?: Record<string, string | number | boolean>;
  studies_overrides?: Record<string, string | number | boolean>;
  custom_css_url?: string;
  custom_font_family?: string;
  loading_screen?: { backgroundColor?: string; foregroundColor?: string };
  toolbar_bg?: string;
  enabled_features?: string[];
  disabled_features?: string[];
  favorites?: { intervals?: TvResolution[]; chartTypes?: string[] };
  time_frames?: { text: string; resolution: TvResolution; description?: string; title?: string }[];
  save_load_adapter?: TvSaveLoadAdapter;
  settings_adapter?: TvSettingsAdapter;
  saved_data?: object;
  auto_save_delay?: number;
  debug?: boolean;
}

/** `window.TradingView` once the standalone loader has run. */
export interface TvGlobal {
  widget: new (options: TvWidgetOptions) => TvWidget;
  version?: () => string;
}
