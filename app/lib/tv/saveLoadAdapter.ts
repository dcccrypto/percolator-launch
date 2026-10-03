/**
 * localStorage-backed save/load for the TradingView chart.
 *
 * Each market (slab) keeps its own layout — drawings, indicators, chart type,
 * resolution — under chart id `slab:<address>`, auto-saved by TvChart via
 * widget.save(). This matches the old chart, whose drawings and indicators
 * were per-slab too. The same adapter also serves study/drawing/chart
 * templates so those menus work. Everything is per-browser; nothing leaves
 * the device.
 *
 * Keys (all `perc:tv:*`):
 *   perc:tv:charts                 index: [{ id, name, symbol, resolution, timestamp }]
 *   perc:tv:chart:<id>             the layout JSON for one chart
 *   perc:tv:study-templates        { [name]: content }
 *   perc:tv:drawing-templates:<tool>  { [name]: content }
 *   perc:tv:chart-templates        { [name]: content }
 */
import type {
  TvChartData,
  TvChartRecord,
  TvSaveLoadAdapter,
  TvStudyTemplateData,
  TvStudyTemplateMeta,
} from "./types";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const INDEX_KEY = "perc:tv:charts";
const chartKey = (id: string) => `perc:tv:chart:${id}`;
const STUDY_TEMPLATES_KEY = "perc:tv:study-templates";
const drawingTemplatesKey = (tool: string) => `perc:tv:drawing-templates:${tool}`;
const CHART_TEMPLATES_KEY = "perc:tv:chart-templates";

/** Upper bound on stored layouts — oldest are evicted. One per visited market. */
export const MAX_STORED_CHARTS = 60;

export function slabChartId(slab: string): string {
  return `slab:${slab}`;
}

/** Storage that never throws: private mode / quota errors degrade to "not saved". */
export function safeStorage(backing: KeyValueStorage | null | undefined): KeyValueStorage {
  return {
    getItem(k) {
      try {
        return backing?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    setItem(k, v) {
      try {
        backing?.setItem(k, v);
      } catch {
        /* quota / privacy mode */
      }
    },
    removeItem(k) {
      try {
        backing?.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}

function readJson<T>(s: KeyValueStorage, key: string, fallback: T, guard: (v: unknown) => v is T): T {
  const raw = s.getItem(key);
  if (raw == null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return guard(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

const isRecordArray = (v: unknown): v is TvChartRecord[] =>
  Array.isArray(v) &&
  v.every(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as TvChartRecord).id === "string" &&
      typeof (r as TvChartRecord).name === "string",
  );

const isStringMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

const isObjectMap = (v: unknown): v is Record<string, object> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "object" && x !== null);

export class LocalStorageSaveLoadAdapter implements TvSaveLoadAdapter {
  private readonly s: KeyValueStorage;
  private readonly now: () => number;

  constructor(storage: KeyValueStorage, now: () => number = Date.now) {
    this.s = safeStorage(storage);
    this.now = now;
  }

  private index(): TvChartRecord[] {
    return readJson(this.s, INDEX_KEY, [], isRecordArray);
  }

  private writeIndex(list: TvChartRecord[]): void {
    this.s.setItem(INDEX_KEY, JSON.stringify(list));
  }

  async getAllCharts(): Promise<TvChartRecord[]> {
    return this.index();
  }

  async removeChart(id: string | number): Promise<void> {
    const key = String(id);
    this.writeIndex(this.index().filter((r) => r.id !== key));
    this.s.removeItem(chartKey(key));
  }

  async saveChart(chart: TvChartData): Promise<string> {
    const id = chart.id != null && String(chart.id) !== "" ? String(chart.id) : `chart:${this.now().toString(36)}`;
    const record: TvChartRecord = {
      id,
      name: chart.name,
      symbol: chart.symbol,
      resolution: chart.resolution,
      timestamp: Math.floor(this.now() / 1000),
    };
    let list = this.index().filter((r) => r.id !== id);
    list.push(record);
    if (list.length > MAX_STORED_CHARTS) {
      list.sort((a, b) => a.timestamp - b.timestamp);
      const evicted = list.slice(0, list.length - MAX_STORED_CHARTS);
      for (const r of evicted) this.s.removeItem(chartKey(r.id));
      list = list.slice(list.length - MAX_STORED_CHARTS);
    }
    this.s.setItem(chartKey(id), chart.content);
    this.writeIndex(list);
    return id;
  }

  async getChartContent(id: string | number): Promise<string> {
    const c = this.s.getItem(chartKey(String(id)));
    if (c == null) throw new Error(`chart ${String(id)} not found`);
    return c;
  }

  async getAllStudyTemplates(): Promise<TvStudyTemplateMeta[]> {
    return Object.keys(readJson(this.s, STUDY_TEMPLATES_KEY, {}, isStringMap)).map((name) => ({ name }));
  }

  async removeStudyTemplate(meta: TvStudyTemplateMeta): Promise<void> {
    const all = readJson(this.s, STUDY_TEMPLATES_KEY, {}, isStringMap);
    delete all[meta.name];
    this.s.setItem(STUDY_TEMPLATES_KEY, JSON.stringify(all));
  }

  async saveStudyTemplate(data: TvStudyTemplateData): Promise<void> {
    const all = readJson(this.s, STUDY_TEMPLATES_KEY, {}, isStringMap);
    all[data.name] = data.content;
    this.s.setItem(STUDY_TEMPLATES_KEY, JSON.stringify(all));
  }

  async getStudyTemplateContent(meta: TvStudyTemplateMeta): Promise<string> {
    const c = readJson(this.s, STUDY_TEMPLATES_KEY, {}, isStringMap)[meta.name];
    if (c == null) throw new Error(`study template ${meta.name} not found`);
    return c;
  }

  async getDrawingTemplates(toolName: string): Promise<string[]> {
    return Object.keys(readJson(this.s, drawingTemplatesKey(toolName), {}, isStringMap));
  }

  async loadDrawingTemplate(toolName: string, templateName: string): Promise<string> {
    const c = readJson(this.s, drawingTemplatesKey(toolName), {}, isStringMap)[templateName];
    if (c == null) throw new Error(`drawing template ${templateName} not found`);
    return c;
  }

  async removeDrawingTemplate(toolName: string, templateName: string): Promise<void> {
    const all = readJson(this.s, drawingTemplatesKey(toolName), {}, isStringMap);
    delete all[templateName];
    this.s.setItem(drawingTemplatesKey(toolName), JSON.stringify(all));
  }

  async saveDrawingTemplate(toolName: string, templateName: string, content: string): Promise<void> {
    const all = readJson(this.s, drawingTemplatesKey(toolName), {}, isStringMap);
    all[templateName] = content;
    this.s.setItem(drawingTemplatesKey(toolName), JSON.stringify(all));
  }

  async getChartTemplateContent(templateName: string): Promise<{ content?: object }> {
    const c = readJson(this.s, CHART_TEMPLATES_KEY, {}, isObjectMap)[templateName];
    return c ? { content: c } : {};
  }

  async getAllChartTemplates(): Promise<string[]> {
    return Object.keys(readJson(this.s, CHART_TEMPLATES_KEY, {}, isObjectMap));
  }

  async saveChartTemplate(name: string, content: object): Promise<void> {
    const all = readJson(this.s, CHART_TEMPLATES_KEY, {}, isObjectMap);
    all[name] = content;
    this.s.setItem(CHART_TEMPLATES_KEY, JSON.stringify(all));
  }

  async removeChartTemplate(name: string): Promise<void> {
    const all = readJson(this.s, CHART_TEMPLATES_KEY, {}, isObjectMap);
    delete all[name];
    this.s.setItem(CHART_TEMPLATES_KEY, JSON.stringify(all));
  }
}

/** The saved layout for a market, parsed, or null. */
export async function loadSlabLayout(adapter: TvSaveLoadAdapter, slab: string): Promise<object | null> {
  try {
    const raw = await adapter.getChartContent(slabChartId(slab));
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export async function saveSlabLayout(
  adapter: TvSaveLoadAdapter,
  slab: string,
  symbolName: string,
  resolution: string,
  state: object,
): Promise<void> {
  await adapter.saveChart({
    id: slabChartId(slab),
    name: symbolName,
    symbol: slab,
    resolution,
    content: JSON.stringify(state),
    timestamp: Math.floor(Date.now() / 1000),
  });
}

/** Widget settings (timezone, UI prefs) persisted to one localStorage key. */
export function createSettingsAdapter(storage: KeyValueStorage) {
  const s = safeStorage(storage);
  const KEY = "perc:tv:settings";
  const read = () => readJson(s, KEY, {}, isStringMap);
  return {
    initialSettings: read(),
    setValue(key: string, value: string) {
      const all = read();
      all[key] = value;
      s.setItem(KEY, JSON.stringify(all));
    },
    removeValue(key: string) {
      const all = read();
      delete all[key];
      s.setItem(KEY, JSON.stringify(all));
    },
  };
}
