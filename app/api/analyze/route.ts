import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { createHash } from "node:crypto";
import { authorized } from "@/lib/supabase";
import {
  analysisSchema,
  context,
  PROMPT_VERSION,
  ANALYSIS_INSTRUCTIONS,
} from "@/lib/analysis";
export const runtime = "nodejs";
export const maxDuration = 60;
const input = z.object({
  document_id: z.uuid(),
  selected: z.string().min(1).max(200),
  start: z.number().int().min(0),
  end: z.number().int().positive(),
});
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
    const sentence = context(doc.content, v.start, v.end, doc.language);
    const key = createHash("sha256")
      .update(
        JSON.stringify([PROMPT_VERSION, doc.language, v.selected, sentence]),
      )
      .digest("hex");
    const { data: cached } = await db
      .from("analysis_cache")
      .select("analysis")
      .eq("cache_key", key)
      .single();
    if (cached)
      return Response.json({
        analysis: analysisSchema.parse(cached.analysis),
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
          analysis: analysisSchema.parse(completed.analysis),
          cached: true,
        });
      stage = "model";
      const ai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: 25000,
        maxRetries: 1,
      });
      const result = await ai.responses.parse({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        max_output_tokens: 3500,
        input: [
          { role: "system", content: ANALYSIS_INSTRUCTIONS },
          {
            role: "user",
            content: JSON.stringify({
              language: doc.language,
              selected: v.selected,
              sentence,
            }),
          },
        ],
        text: { format: zodTextFormat(analysisSchema, "word_analysis") },
      });
      stage = "validate";
      const a = analysisSchema.parse(result.output_parsed);
      const normalized = (text: string) =>
        text.normalize("NFC").replace(/\s+/gu, " ").trim();
      if (
        normalized(a.original_word) !== normalized(v.selected) ||
        a.language !== doc.language
      )
        throw Error("Ответ модели не соответствует выделению");
      // These fields are source data, not model-generated content. Segmenter often
      // includes trailing spaces/newlines that the model does not echo verbatim.
      a.original_word = v.selected;
      a.original_sentence = sentence;
      stage = "save";
      const { error } = await db.from("analysis_cache").upsert(
        {
          owner_id: user.id,
          document_id: v.document_id,
          cache_key: key,
          analysis: a,
        },
        { onConflict: "owner_id,cache_key" },
      );
      if (error) throw error;
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
