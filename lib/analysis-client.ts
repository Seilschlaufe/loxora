import {
  analysisSchema,
  expandedSchema,
  demoAnalysis,
  demoExpanded,
  PROMPT_VERSION,
  type Analysis,
  type ExpandedAnalysis,
} from "./analysis";
import { readLocal, writeLocal } from "./local";
export type AnalysisSource =
  | { document_id: string; selected: string; start: number; end: number }
  | { vocabulary_entry_id: string };
type Mode = "compact" | "expanded";
type Result<M extends Mode> = M extends "compact" ? Analysis : ExpandedAnalysis;
type RequestOptions<M extends Mode> = {
  mode: M;
  scope: string;
  token?: string;
  source: AnalysisSource;
  selection: {
    word: string;
    sentence: string;
    language: Analysis["language"];
    sentenceOffset?: number;
  };
  compact?: Analysis;
  signal?: AbortSignal;
  canStore: () => boolean;
};
// Scope is part of the in-flight key: another account never shares a pending result.
const pending = new Map<string, Promise<Analysis | ExpandedAnalysis>>();
export async function requestAnalysis<M extends Mode>(
  options: RequestOptions<M>,
): Promise<Result<M>> {
  const { mode, scope, selection, source } = options;
  // Compact results include trusted absolute source spans, so local cache also
  // identifies the selection. Expanded meaning can be reused from the dictionary.
  const key =
    scope +
    ":analysis:" +
    JSON.stringify([
      PROMPT_VERSION,
      mode,
      selection.language,
      selection.word,
      selection.sentence,
      mode === "compact"
        ? source
        : (options.compact?.selection_offset ??
          selection.sentence.indexOf(selection.word)),
    ]);
  const existing = pending.get(key);
  if (existing) return (await existing) as Result<M>;
  const task = (async () => {
    const schema = mode === "compact" ? analysisSchema : expandedSchema;
    const cached = schema.safeParse(await readLocal<unknown>(key));
    if (cached.success) return cached.data;
    if (!navigator.onLine)
      throw Error(
        "Нет подключения. Ранее разобранные слова доступны из кэша; новый анализ требует интернет.",
      );
    let result: Analysis | ExpandedAnalysis;
    if (!options.token) {
      result =
        mode === "compact"
          ? demoAnalysis(
              selection.word,
              selection.sentence,
              selection.language,
              selection.sentenceOffset || 0,
            )
          : demoExpanded(options.compact!);
    } else {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({ ...source, mode }),
        signal: options.signal,
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Ошибка анализа");
      result = schema.parse(data.analysis);
    }
    if (mode === "compact" && "start" in source && !options.token) {
      (result as Analysis).selection_offset =
        source.start - (selection.sentenceOffset || 0);
    }
    if (options.canStore()) await writeLocal(key, result);
    return result;
  })();
  pending.set(key, task);
  try {
    return (await task) as Result<M>;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}
