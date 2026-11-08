import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { createHash } from "node:crypto";
import { authorized } from "@/lib/supabase";
import {
  analysisSchema,
  language,
  modelAnalysisSchema,
  expandedSchema,
  EXPANDED_INSTRUCTIONS,
  resolveAnalysis,
  toCompact,
  context,
  PROMPT_VERSION,
  ANALYSIS_INSTRUCTIONS,
} from "@/lib/analysis";
export const runtime = "nodejs";
export const maxDuration = 60;
const documentInput = z.object({
  mode: z.enum(["compact", "expanded"]).default("compact"),
  document_id: z.uuid(),
  selected: z.string().min(1).max(200),
  start: z.number().int().min(0),
  end: z.number().int().positive(),
});
const input = z.union([
  documentInput,
  z.object({ mode: z.literal("expanded"), vocabulary_entry_id: z.uuid() }),
]);
export async function POST(req: Request) {
  let stage = "auth";
  try {
    const { db, user } = await authorized(req);
    if (Number(req.headers.get("content-length") || 0) > 4096)
      return Response.json(
        { error: "Слишком большой запрос" },
        { status: 413 },
      );
    const raw = await limitedBody(req);
    const parsed = input.safeParse(JSON.parse(raw));
    if (!parsed.success)
      return Response.json(
        { error: "Некорректное выделение" },
        { status: 400 },
      );
    const v = parsed.data;
    const mode = v.mode;
    let selected: string,
      sentence: string,
      sourceText: string,
      selectionStart: number,
      sourceLanguage: "de" | "en" | "es",
      documentId: string | null;
    if ("vocabulary_entry_id" in v) {
      const { data: entry } = await db
        .from("vocabulary_entries")
        .select("analysis,document_id")
        .eq("id", v.vocabulary_entry_id)
        .single();
      if (!entry)
        return Response.json(
          { error: "Запись словаря недоступна" },
          { status: 404 },
        );
      const saved = toCompact(entry.analysis);
      selected = saved.original_word;
      sentence = saved.original_sentence;
      // This source comes from the caller's stored row, never a client-supplied card.
      if (selected.length > 200 || sentence.length > 1800)
        return Response.json(
          { error: "Контекст записи слишком большой" },
          { status: 400 },
        );
      sourceText = sentence;
      const storedOffset = saved.selection_offset;
      selectionStart =
        typeof storedOffset === "number" &&
        sentence.slice(storedOffset, storedOffset + selected.length) ===
          selected
          ? storedOffset
          : sentence.indexOf(selected);
      sourceLanguage = saved.language;
      documentId = entry.document_id;
      if (selectionStart < 0)
        return Response.json(
          { error: "Исходное слово отсутствует в контексте записи" },
          { status: 400 },
        );
    } else {
      const { data: doc } = await db
        .from("documents")
        .select("*")
        .eq("id", v.document_id)
        .single();
      if (!doc)
        return Response.json({ error: "Документ недоступен" }, { status: 404 });
      if (
        v.end <= v.start ||
        v.end > doc.content.length ||
        doc.content.slice(v.start, v.end) !== v.selected
      )
        return Response.json(
          { error: "Выделение не соответствует документу" },
          { status: 400 },
        );
      selected = v.selected;
      sentence = context(doc.content, v.start, v.end, doc.language);
      sourceText = doc.content;
      selectionStart = v.start;
      sourceLanguage = language.parse(doc.language);
      documentId = v.document_id;
    }
    const source = {
      text: sourceText,
      sentence,
      selected,
      start: selectionStart,
      language: sourceLanguage,
    };
    const contextStart = sourceText.lastIndexOf(sentence, selectionStart);
    const parseCached = (value: unknown) => {
      if (mode === "expanded") return expandedSchema.parse(value);
      const compact = analysisSchema.parse(value);
      return resolveAnalysis(
        {
          ...compact,
          construction: compact.construction
            ? {
                ...compact.construction,
                parts: compact.construction.parts.map((part) => part.text),
              }
            : null,
        },
        source,
      );
    };
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          PROMPT_VERSION,
          mode,
          sourceLanguage,
          selected,
          sentence,
          selectionStart - contextStart,
        ]),
      )
      .digest("hex");
    const { data: cached } = await db
      .from("analysis_cache")
      .select("analysis")
      .eq("cache_key", key)
      .single();
    if (cached)
      return Response.json({
        analysis: parseCached(cached.analysis),
        cached: true,
      });
    if (!process.env.OPENAI_API_KEY)
      return Response.json(
        { error: "На сервере не настроен OpenAI API key" },
        { status: 503 },
      );
    // Atomic per-user quota and lease prevent duplicate paid requests across server instances.
    const { data: lease, error: leaseError } = await db.rpc("claim_analysis", {
      p_key: key,
    });
    if (leaseError)
      return Response.json(
        { error: "База данных недоступна. Проверьте настройку миграции." },
        { status: 503 },
      );
    if (lease !== "ok")
      return Response.json(
        {
          error:
            lease === "busy"
              ? "Анализ уже выполняется. Повторите через несколько секунд."
              : "Лимит: 20 запросов в минуту. Повторите позже.",
        },
        { status: 429 },
      );
    try {
      const { data: completed } = await db
        .from("analysis_cache")
        .select("analysis")
        .eq("cache_key", key)
        .single();
      if (completed)
        return Response.json({
          analysis: parseCached(completed.analysis),
          cached: true,
        });
      stage = "model";
      const ai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: 25000,
        maxRetries: 1,
      });
      const instructions =
        mode === "compact" ? ANALYSIS_INSTRUCTIONS : EXPANDED_INSTRUCTIONS;
      const messages = [
        { role: "system" as const, content: instructions },
        {
          role: "user" as const,
          content: JSON.stringify({
            language: sourceLanguage,
            selected,
            sentence,
            selection_start: selectionStart - contextStart,
            selection_end: selectionStart - contextStart + selected.length,
          }),
        },
      ];
      // The expanded schema is never requested by a compact click.
      const result =
        mode === "compact"
          ? await ai.responses.parse({
              model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
              max_output_tokens: 1200,
              input: messages,
              text: {
                format: zodTextFormat(
                  modelAnalysisSchema,
                  "compact_word_analysis",
                ),
              },
            })
          : await ai.responses.parse({
              model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
              max_output_tokens: 1800,
              input: messages,
              text: {
                format: zodTextFormat(expandedSchema, "expanded_word_meaning"),
              },
            });
      stage = "validate";
      const a =
        mode === "compact"
          ? resolveAnalysis(result.output_parsed, source)
          : expandedSchema.parse(result.output_parsed);
      // A surviving vocabulary snapshot may have no document after deletion.
      // Avoid recreating unbound server data if that row/all data is deleted
      // while this request runs. Its result is cached only by the caller's client.
      if (documentId !== null) {
        stage = "save";
        const { error } = await db.from("analysis_cache").upsert(
          {
            owner_id: user.id,
            document_id: documentId,
            cache_key: key,
            analysis: a,
          },
          { onConflict: "owner_id,cache_key" },
        );
        if (error) throw error;
      }
      return Response.json({ analysis: a, cached: false });
    } finally {
      await db.from("analysis_leases").delete().eq("cache_key", key);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message === "SIZE")
      return Response.json(
        { error: "Слишком большой запрос" },
        { status: 413 },
      );
    if (e instanceof SyntaxError)
      return Response.json({ error: "Некорректный JSON" }, { status: 400 });
    // Expose only known categories, never raw provider messages, keys or document text.
    if (stage === "save")
      return Response.json(
        {
          error:
            "Анализ получен, но не сохранён. Проверьте миграцию Supabase и наличие исходного документа.",
        },
        { status: 503 },
      );
    if (stage === "validate")
      return Response.json(
        {
          error:
            "Модель вернула некорректный разбор или изменила исходный текст. Повторите анализ.",
        },
        { status: 502 },
      );
    if (stage === "model") {
      const provider =
        e && typeof e === "object"
          ? (e as { code?: unknown; status?: unknown; name?: unknown })
          : {};
      if (provider.code === "insufficient_quota")
        return Response.json(
          {
            error:
              "У OpenAI API закончилась квота или не настроена оплата. Проверьте Billing на platform.openai.com. Подписка ChatGPT не оплачивает API.",
          },
          { status: 503 },
        );
      if (provider.status === 401)
        return Response.json(
          {
            error:
              "OpenAI отклонил API-ключ. Проверьте OPENAI_API_KEY в .env.local и перезапустите приложение.",
          },
          { status: 502 },
        );
      if (provider.code === "model_not_found" || provider.status === 404)
        return Response.json(
          {
            error:
              "Модель OpenAI недоступна. Проверьте OPENAI_MODEL и доступ к модели в своём API-проекте.",
          },
          { status: 503 },
        );
      if (provider.status === 429)
        return Response.json(
          {
            error:
              "OpenAI временно ограничил запросы. Подождите минуту и проверьте лимиты API-проекта.",
          },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      if (provider.status === 403)
        return Response.json(
          {
            error:
              "OpenAI запретил запрос. Проверьте права API-ключа и доступность API для вашего аккаунта и региона.",
          },
          { status: 503 },
        );
      if (provider.name === "APIConnectionTimeoutError")
        return Response.json(
          { error: "OpenAI не ответил вовремя. Повторите запрос позже." },
          { status: 504 },
        );
      if (provider.name === "APIConnectionError")
        return Response.json(
          {
            error:
              "Не удалось подключиться к OpenAI. Проверьте интернет и доступ к api.openai.com.",
          },
          { status: 502 },
        );
      if (provider.status === 400 || provider.status === 422)
        return Response.json(
          {
            error:
              "OpenAI отклонил параметры анализа. Проверьте поддержку Responses API и Structured Outputs выбранной моделью.",
          },
          { status: 502 },
        );
    }
    const auth = message === "AUTH";
    return Response.json(
      {
        error: auth
          ? "Необходимо войти"
          : "Не удалось выполнить анализ. Повторите позже.",
      },
      { status: auth ? 401 : 502 },
    );
  }
}

async function limitedBody(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new SyntaxError("empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw Error("SIZE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
