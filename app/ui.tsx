"use client";
import { useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { browserDb } from "@/lib/supabase";
import { readLocal, writeLocal, clearScope } from "@/lib/local";
import AnalysisCard from "./analysis-card";
import { requestAnalysis, type AnalysisSource } from "@/lib/analysis-client";
import {
  compactEntry,
  compactEntries,
  vocabularyExport,
} from "@/lib/vocabulary";
import {
  Analysis,
  Document,
  Entry,
  context,
  segments,
  toCompact,
  type ExpandedAnalysis,
} from "@/lib/analysis";

const langs = { de: "Немецкий", en: "Английский", es: "Испанский" };
const demoDoc: Document = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "Маленькое путешествие",
  language: "de",
  created_at: "2026-01-01T00:00:00Z",
  content:
    "An einem ruhigen Morgen beschloss Anna, eine Reise zu machen. Sie steht früh auf und öffnet das Fenster. Die Stadt schläft noch.\n\nAuf dem Tisch liegt ein Buch. Anna liest jeden Tag ein paar Seiten, denn jedes neue Wort öffnet eine kleine Tür.\n\nHeute beginnt eine neue Geschichte. Sie nimmt ihre Tasche und geht zum Bahnhof.",
};
type Prefs = { theme: "light" | "dark" | "system"; font_size: number };
type Snapshot = {
  docs: Document[];
  entries: Entry[];
  progress: Record<string, number>;
  prefs: Prefs;
  selected: string;
};
type Card = {
  analysis: Analysis;
  demo: boolean;
  document_id: string | null;
  source: AnalysisSource;
};
type InstallEvent = Event & { prompt: () => Promise<void> };
const empty: Snapshot = {
  docs: [],
  entries: [],
  progress: {},
  prefs: { theme: "light", font_size: 22 },
  selected: "",
};
const nav = [
  ["/library", "Библиотека", "▤"],
  ["/read", "Читать", "▥"],
  ["/vocabulary", "Словарь", "Aa"],
  ["/settings", "Настройки", "⚙"],
];
export default function Lexora() {
  const path = usePathname();
  const view = path === "/" ? "/library" : path;
  const db = useMemo(() => browserDb(), []);
  const [session, setSession] = useState<Session | null>(null),
    [authReady, setAuthReady] = useState(false),
    [ready, setReady] = useState(false);
  const scope = session?.user.id || "demo";
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const loadedScope = useRef("");
  const dataEpoch = useRef(0);
  const [state, setState] = useState<Snapshot>(empty);
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(true);
  const [syncTick, setSyncTick] = useState(0);
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("new");
  const [adding, setAdding] = useState(false),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [lang, setLang] = useState<"de" | "en" | "es">("de");
  const [card, setCard] = useState<Card | null>(null),
    [expanded, setExpanded] = useState<ExpandedAnalysis | null>(null),
    [expandedLoading, setExpandedLoading] = useState(false),
    [expandedError, setExpandedError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<{
      start: number;
      end: number;
      rect: DOMRect;
    } | null>(null),
    [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const [email, setEmail] = useState(""),
    [install, setInstall] = useState<InstallEvent | null>(null);
  const reader = useRef<HTMLDivElement>(null),
    requestId = useRef(0),
    abort = useRef<AbortController | null>(null);
  const selected =
    state.docs.find((d) => d.id === state.selected) || state.docs[0];
  const tokens = useMemo(
    () => (selected ? segments(selected.content, selected.language) : []),
    [selected?.content, selected?.language],
  );
  useEffect(() => {
    if (!db) {
      setAuthReady(true);
      return;
    }
    let alive = true;
    db.auth.getSession().then(({ data }) => {
      if (alive) {
        setSession(data.session);
        setAuthReady(true);
      }
    });
    const { data } = db.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setAuthReady(true);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [db]);
  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) setSyncTick((n) => n + 1);
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const installHandler = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", installHandler);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.removeEventListener("beforeinstallprompt", installHandler);
    };
  }, []);
  useEffect(() => {
    if (!authReady) return;
    let alive = true;
    loadedScope.current = "";
    setReady(false);
    setBusy(false);
    setState(empty);
    setCard(null);
    setSearch("");
    requestId.current++;
    abort.current?.abort();
    (async () => {
      try {
        let local = await readLocal<Snapshot>(scope + ":snapshot");
        if (!local)
          local =
            scope === "demo"
              ? { ...empty, docs: [demoDoc], selected: demoDoc.id }
              : empty;
        local = { ...local, entries: compactEntries(local.entries) };
        if (alive) setState(local);
        if (session && db && navigator.onLine) {
          const results = await Promise.all([
            db
              .from("documents")
              .select("*")
              .order("created_at", { ascending: false }),
            db
              .from("vocabulary_entries")
              .select("*")
              .order("created_at", { ascending: false }),
            db.from("reading_progress").select("*"),
            db.from("user_preferences").select("*").maybeSingle(),
          ]);
          if (results.some((r) => r.error))
            throw Error(
              "Не удалось загрузить данные из облака. Доступна локальная копия.",
            );
          const docs = results[0].data as Document[],
            entries = compactEntries(results[1].data);
          const progress = Object.fromEntries(
            (results[2].data || []).map((p) => [p.document_id, p.position]),
          );
          local = {
            ...local,
            docs,
            entries,
            progress,
            prefs: results[3].data
              ? {
                  theme: results[3].data.theme,
                  font_size: results[3].data.font_size,
                }
              : local.prefs,
          };
          if (alive) {
            setState(local);
            await writeLocal(scope + ":snapshot", local);
          }
        }
      } catch (e) {
        if (alive)
          setNotice(
            e instanceof Error ? e.message : "Локальное хранилище недоступно",
          );
      } finally {
        if (alive) {
          loadedScope.current = scope;
          setReady(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [authReady, scope, db, session?.access_token, syncTick]);
  useEffect(() => {
    if (ready && loadedScope.current === scope)
      writeLocal(scope + ":snapshot", state).catch(() =>
        setNotice(
          "Не удалось сохранить локальную копию. Проверьте свободное место.",
        ),
      );
  }, [state, scope, ready]);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        state.prefs.theme === "dark" ||
        (state.prefs.theme === "system" && query.matches)
          ? "dark"
          : "light";
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [state.prefs.theme]);
  useEffect(() => {
    if (!ready || !selected || view !== "/read") return;
    requestAnimationFrame(() =>
      window.scrollTo(0, state.progress[selected.id] || 0),
    );
    const save = () => {
      const position = Math.round(window.scrollY);
      setState((s) => ({
        ...s,
        progress: { ...s.progress, [selected.id]: position },
      }));
    };
    let timer: ReturnType<typeof setTimeout>;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(save, 250);
    };
    window.addEventListener("scroll", handler, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", handler);
    };
  }, [ready, selected?.id, view]);
  useEffect(() => {
    if (!session || !db || !selected || view !== "/read") return;
    const position = state.progress[selected.id] || 0;
    const timer = setTimeout(() => {
      if (navigator.onLine)
        db.from("reading_progress")
          .upsert({
            owner_id: session.user.id,
            document_id: selected.id,
            position,
          })
          .then(({ error }) => {
            if (error) setNotice("Позиция сохранена только на устройстве");
          });
    }, 1200);
    return () => clearTimeout(timer);
  }, [state.progress, session, db, selected?.id, view]);
  useEffect(() => {
    if (!adding) return;
    readLocal<{ title: string; content: string; lang: "de" | "en" | "es" }>(
      scope + ":draft",
    ).then((d) => {
      if (d) {
        setTitle(d.title);
        setContent(d.content);
        setLang(d.lang);
      }
    });
  }, [adding, scope]);
  useEffect(() => {
    if (adding)
      writeLocal(scope + ":draft", { title, content, lang }).catch(() => {});
  }, [title, content, lang, adding, scope]);
  useEffect(() => {
    if (!adding && !card && !busy) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(
      adding ? ".modal" : ".analysis-card",
    );
    if (!dialog) return;
    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, textarea, a[href], [tabindex="0"]',
        ),
      );
    focusables()[0]?.focus({ preventScroll: true });
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = focusables();
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", trap);
    return () => {
      dialog.removeEventListener("keydown", trap);
      previous?.focus({ preventScroll: true });
    };
  }, [adding, !!card, busy]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        requestId.current++;
        setCard(null);
        setBusy(false);
        setAdding(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (view !== "/read") return;
    const dismiss = () => {
      requestId.current++;
      setCard(null);
      setBusy(false);
      setSelection(null);
    };
    window.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [view]);
  async function cloudWrite(
    table: string,
    data: Record<string, unknown>,
    upsert = false,
  ) {
    if (!db || !session) return;
    if (!navigator.onLine)
      throw Error(
        "Для изменения облачных данных нужно подключение. Чтение доступно офлайн.",
      );
    const r = upsert
      ? await db.from(table).upsert({ ...data, owner_id: session.user.id })
      : await db.from(table).insert({ ...data, owner_id: session.user.id });
    if (r.error) throw Error("Ошибка синхронизации. Изменение не сохранено.");
  }
  function showError(e: unknown) {
    setNotice(e instanceof Error ? e.message : "Не удалось выполнить действие");
  }
  async function addDocument(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || !title.trim()) return;
    setSaving(true);
    const operationScope = scope;
    try {
      const doc: Document = {
        id: crypto.randomUUID(),
        title: title.trim(),
        content,
        language: lang,
        created_at: new Date().toISOString(),
      };
      await cloudWrite("documents", doc);
      if (scopeRef.current !== operationScope) return;
      setState((s) => ({ ...s, docs: [doc, ...s.docs], selected: doc.id }));
      setAdding(false);
      setContent("");
      setTitle("");
      await writeLocal(scope + ":draft", { title: "", content: "", lang });
      setNotice("Текст сохранён. Можно начинать читать.");
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }
  async function removeDoc(doc: Document) {
    if (!confirm(`Удалить «${doc.title}»? Слова останутся в словаре.`)) return;
    try {
      if (session && db) {
        if (!online) throw Error("Нужно подключение к интернету");
        const { error } = await db.from("documents").delete().eq("id", doc.id);
        if (error) throw error;
      }
      setState((s) => ({
        ...s,
        docs: s.docs.filter((d) => d.id !== doc.id),
        entries: s.entries.map((e) =>
          e.document_id === doc.id ? { ...e, document_id: "" } : e,
        ),
      }));
    } catch (e) {
      showError(e);
    }
  }
  async function renameDoc(doc: Document) {
    const title = prompt("Новое название", doc.title)?.trim();
    if (!title || title.length > 120) return;
    try {
      if (session && db) {
        if (!online) throw Error("Нужно подключение к интернету");
        const { error } = await db
          .from("documents")
          .update({ title })
          .eq("id", doc.id);
        if (error) throw error;
      }
      setState((s) => ({
        ...s,
        docs: s.docs.map((d) => (d.id === doc.id ? { ...d, title } : d)),
      }));
    } catch (e) {
      showError(e);
    }
  }
  async function analyze(start: number, end: number, rect?: DOMRect) {
    if (!selected) return;
    const id = ++requestId.current;
    const owner = scope;
    const epoch = dataEpoch.current;
    const doc = selected;
    const word = doc.content.slice(start, end);
    if (!word.trim() || word.length > 200) {
      setNotice("Выберите выражение длиной до 200 символов");
      return;
    }
    setSelection(null);
    setCard(null);
    setExpanded(null);
    setExpandedError(null);
    setExpandedLoading(false);
    setBusy(true);
    if (rect) {
      const width = Math.min(420, window.innerWidth - 24);
      setAnchor({
        x:
          window.scrollX +
          Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        y: rect.bottom + 8,
      });
    }
    const sentence = context(doc.content, start, end, doc.language);
    const source: AnalysisSource = {
      document_id: doc.id,
      selected: word,
      start,
      end,
    };
    const controller = new AbortController();
    abort.current = controller;
    try {
      const analysis = await requestAnalysis({
        mode: "compact",
        scope: owner,
        token: session?.access_token,
        source,
        selection: {
          word,
          sentence,
          language: doc.language,
          sentenceOffset: doc.content.lastIndexOf(sentence, start),
        },
        signal: controller.signal,
        canStore: () =>
          owner === scopeRef.current && epoch === dataEpoch.current,
      });
      if (
        id === requestId.current &&
        owner === scopeRef.current &&
        epoch === dataEpoch.current
      )
        setCard({ analysis, demo: !session, document_id: doc.id, source });
    } catch (e) {
      if (id === requestId.current) showError(e);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }
  async function expandAnalysis() {
    if (!card || expandedLoading || expanded) return;
    const id = requestId.current,
      owner = scope,
      epoch = dataEpoch.current;
    setExpandedLoading(true);
    setExpandedError(null);
    try {
      const result = await requestAnalysis({
        mode: "expanded",
        scope: owner,
        token: session?.access_token,
        source: card.source,
        selection: {
          word: card.analysis.original_word,
          sentence: card.analysis.original_sentence,
          language: card.analysis.language,
        },
        compact: card.analysis,
        canStore: () =>
          owner === scopeRef.current && epoch === dataEpoch.current,
      });
      if (
        id === requestId.current &&
        owner === scopeRef.current &&
        epoch === dataEpoch.current
      )
        setExpanded(result);
    } catch (e) {
      if (id === requestId.current)
        setExpandedError(
          e instanceof Error ? e.message : "Не удалось получить объяснение",
        );
    } finally {
      if (id === requestId.current) setExpandedLoading(false);
    }
  }

  function captureSelection() {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      !reader.current ||
      !selection.rangeCount
    ) {
      setSelection(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !reader.current.contains(range.startContainer) ||
      !reader.current.contains(range.endContainer)
    )
      return;
    const before = document.createRange();
    before.selectNodeContents(reader.current);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length,
      end = start + range.toString().length;
    setSelection({ start, end, rect: range.getBoundingClientRect() });
  }
  async function saveWord() {
    if (!card || saving) return;
    setSaving(true);
    const operationScope = scope;
    try {
      const a = toCompact(card.analysis);
      const rawKey = JSON.stringify([
        card.document_id,
        a.original_word,
        a.original_sentence,
      ]);
      const dedupe_key = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(rawKey),
          ),
        ),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (
        state.entries.some(
          (e) =>
            e.document_id === card.document_id &&
            e.analysis.original_word === a.original_word &&
            e.analysis.original_sentence === a.original_sentence,
        )
      ) {
        setNotice("Слово уже в словаре");
        return;
      }
      const entry = compactEntry({
        id: crypto.randomUUID(),
        document_id: card.document_id,
        created_at: new Date().toISOString(),
        analysis: a,
        demo: card.demo,
      });
      await cloudWrite("vocabulary_entries", { ...entry, dedupe_key });
      if (scopeRef.current !== operationScope) return;
      setState((s) => ({ ...s, entries: [entry, ...s.entries] }));
      setNotice("Слово добавлено в словарь");
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }
  async function deleteEntry(id: string) {
    try {
      if (session && db) {
        if (!online) throw Error("Нужно подключение к интернету");
        const { error } = await db
          .from("vocabulary_entries")
          .delete()
          .eq("id", id);
        if (error) throw error;
      }
      setState((s) => ({
        ...s,
        entries: s.entries.filter((e) => e.id !== id),
      }));
      setNotice("Слово удалено");
    } catch (e) {
      showError(e);
    }
  }
  async function preferences(prefs: Prefs) {
    try {
      await cloudWrite("user_preferences", prefs, true);
      setState((s) => ({ ...s, prefs }));
    } catch (e) {
      showError(e);
    }
  }
  function exportWords(format: "json" | "csv") {
    const text = vocabularyExport(state.entries, format);
    const url = URL.createObjectURL(
      new Blob([text], {
        type: format === "json" ? "application/json" : "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "lexora-vocabulary." + format;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function deleteData() {
    if (
      !confirm(
        "Удалить все свои тексты, слова, настройки и локальный кэш? Это нельзя отменить.",
      )
    )
      return;
    dataEpoch.current++;
    requestId.current++;
    abort.current?.abort();
    setCard(null);
    setBusy(false);
    try {
      if (session && db) {
        const { error } = await db.rpc("delete_my_data");
        if (error) throw Error("Не удалось удалить облачные данные");
      }
      await clearScope(scope);
      setState(empty);
      setCard(null);
      setNotice("Все сохранённые данные удалены");
    } catch (e) {
      showError(e);
    }
  }
  useEffect(() => {
    requestId.current++;
    setCard(null);
    setBusy(false);
    setSelection(null);
  }, [view, selected?.id]);
  const words = state.entries
    .filter(
      (e) =>
        (filter === "all" || e.analysis.language === filter) &&
        [
          e.analysis.original_word,
          e.analysis.lemma,
          e.analysis.contextual_translation_ru,
        ]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "new"
        ? b.created_at.localeCompare(a.created_at)
        : a.created_at.localeCompare(b.created_at),
    );
  const labels: Record<string, string> = {
    "/library": "Библиотека",
    "/read": "Читалка",
    "/vocabulary": "Мой словарь",
    "/settings": "Настройки",
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/library" className="brand">
          <span className="brand-symbol">
            L<span>✦</span>
          </span>
          lexora<span className="brand-dot">.</span>
        </Link>
        <p className="brand-caption">СЛОВО ЗА СЛОВОМ</p>
        <nav>
          {nav.map(([href, label, icon]) => (
            <Link
              href={href}
              key={href}
              className={view === href ? "active" : ""}
            >
              <span className="nav-icon">{icon}</span>
              {label}
              {href === "/vocabulary" && <small>{state.entries.length}</small>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="little-leaf">✳</span>
          <p>
            Большие истории
            <br />
            начинаются с одного слова.
          </p>
          <div className="profile">
            <span className="avatar">{session ? "Я" : "Д"}</span>
            <div>
              <strong>
                {session ? "Личный аккаунт" : "Демо-пространство"}
              </strong>
              <small>
                {session
                  ? "Облачная синхронизация"
                  : "Хранится на этом устройстве"}
              </small>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>{labels[view] || "Библиотека"}</span>
          <div>
            <span className="status-dot" />
            {online ? "Можно читать" : "Вы офлайн"}
            {session && (
              <button
                className="sync-button"
                aria-label="Синхронизировать"
                disabled={!online}
                onClick={() => setSyncTick((n) => n + 1)}
              >
                ↻
              </button>
            )}
            <Link
              href="/settings"
              className="header-avatar"
              aria-label="Открыть настройки"
            >
              {session ? "Я" : "Д"}
            </Link>
          </div>
        </header>
        {!session && (
          <div className="demo-banner">
            <span>✦</span> Деморежим · карточки тестовые, данные только на этом
            устройстве.<Link href="/settings">Подключить аккаунт →</Link>
          </div>
        )}
        {!online && (
          <div className="offline-banner">
            Нет подключения. Доступны загруженные тексты и сохранённые карточки.
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            {notice}
            <button
              aria-label="Закрыть уведомление"
              onClick={() => setNotice("")}
            >
              ×
            </button>
          </div>
        )}
        {!ready ? (
          <div className="loading">Открываем вашу библиотеку…</div>
        ) : (
          <div className={"page " + (view === "/read" ? "reader-page" : "")}>
            {view === "/library" && (
              <>
                <div className="eyebrow">ВАШЕ ПРОСТРАНСТВО ДЛЯ ЯЗЫКОВ</div>
                <section className="page-heading">
                  <div>
                    <h1>
                      Каждый текст —<br />
                      <em>новое открытие.</em>
                    </h1>
                    <p>
                      Читайте то, что интересно. Понимайте больше с каждым
                      словом.
                    </p>
                  </div>
                  <button className="primary" onClick={() => setAdding(true)}>
                    <b>＋</b> Добавить текст
                  </button>
                </section>
                <div className="stat-strip">
                  <div>
                    <span className="stat-icon">▤</span>
                    <strong>{state.docs.length}</strong>
                    <span>текстов в библиотеке</span>
                  </div>
                  <div>
                    <span className="stat-icon">Aa</span>
                    <strong>{state.entries.length}</strong>
                    <span>слов сохранено</span>
                  </div>
                  <div>
                    <span className="stat-icon">◎</span>
                    <strong>
                      {new Set(state.docs.map((d) => d.language)).size}
                    </strong>
                    <span>языков в изучении</span>
                  </div>
                </div>
                <div className="section-toolbar">
                  <h2>
                    Мои тексты <span>{state.docs.length}</span>
                  </h2>
                  <label className="search">
                    <span>⌕</span>
                    <input
                      aria-label="Поиск по названиям"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Найти текст…"
                    />
                  </label>
                </div>
                <div className="document-grid">
                  {state.docs
                    .filter((d) =>
                      d.title.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((doc, i) => (
                      <article className="document-card" key={doc.id}>
                        <div className={"card-art art-" + (i % 3)}>
                          <span className="art-letter">
                            {doc.language === "de"
                              ? "Aa"
                              : doc.language === "en"
                                ? "Ww"
                                : "Ññ"}
                          </span>
                          <span className="art-line" />
                          <span className="language-badge">
                            {doc.language === "de"
                              ? "🇩🇪"
                              : doc.language === "en"
                                ? "🇬🇧"
                                : "🇪🇸"}{" "}
                            {langs[doc.language]}
                          </span>
                        </div>
                        <div className="document-body">
                          <div className="document-meta">
                            ТЕКСТ ·{" "}
                            {Math.max(
                              1,
                              Math.ceil(doc.content.split(/\s+/).length / 180),
                            )}{" "}
                            МИН ЧТЕНИЯ
                          </div>
                          <h3>
                            <Link
                              href="/read"
                              onClick={() =>
                                setState((s) => ({ ...s, selected: doc.id }))
                              }
                            >
                              {doc.title}
                            </Link>
                          </h3>
                          <p>
                            {doc.content.slice(0, 115)}
                            {doc.content.length > 115 ? "…" : ""}
                          </p>
                          <footer>
                            <span>
                              {new Date(doc.created_at).toLocaleDateString(
                                "ru-RU",
                              )}
                            </span>
                            <div>
                              <button
                                aria-label={"Переименовать " + doc.title}
                                onClick={() => renameDoc(doc)}
                              >
                                ✎
                              </button>
                              <button
                                aria-label={"Удалить " + doc.title}
                                onClick={() => removeDoc(doc)}
                              >
                                ⌫
                              </button>
                              <Link
                                href="/read"
                                aria-label={"Читать " + doc.title}
                                onClick={() =>
                                  setState((s) => ({ ...s, selected: doc.id }))
                                }
                              >
                                ↗
                              </Link>
                            </div>
                          </footer>
                        </div>
                      </article>
                    ))}
                  <button className="add-card" onClick={() => setAdding(true)}>
                    <span>＋</span>
                    <strong>Ваша следующая история</strong>
                    <small>Вставьте текст и начните читать</small>
                  </button>
                </div>
                <div className="library-note">
                  <span>✧</span>
                  <p>
                    Не нужно понимать каждое слово.
                    <br />
                    <strong>Достаточно любопытства, чтобы начать.</strong>
                  </p>
                  <span className="note-line" />
                </div>
              </>
            )}
            {view === "/read" && (
              <>
                {selected ? (
                  <>
                    <div className="reader-toolbar">
                      <Link href="/library">← В библиотеку</Link>
                      <label>
                        Размер текста{" "}
                        <input
                          aria-label="Размер шрифта"
                          type="range"
                          min="16"
                          max="32"
                          value={state.prefs.font_size}
                          onChange={(e) =>
                            preferences({
                              ...state.prefs,
                              font_size: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="reader-heading">
                      <span className="eyebrow">
                        {langs[selected.language]} · ЧИТАЙТЕ В СВОЁМ РИТМЕ
                      </span>
                      <h1>{selected.title}</h1>
                      <p>
                        Нажмите на слово, чтобы понять его. Выделите фразу для
                        разбора выражения.
                      </p>
                    </div>
                    <div
                      ref={reader}
                      data-testid="reader-text"
                      className="reader-text"
                      style={{ fontSize: state.prefs.font_size }}
                      onMouseUp={captureSelection}
                      onTouchEnd={() => setTimeout(captureSelection, 50)}
                    >
                      {tokens.map((s) =>
                        s.word ? (
                          <span
                            role="button"
                            tabIndex={0}
                            key={s.start}
                            className="reader-word"
                            data-start={s.start}
                            data-end={s.end}
                            onClick={(e) => {
                              if (window.getSelection()?.toString()) return;
                              analyze(
                                s.start,
                                s.end,
                                e.currentTarget.getBoundingClientRect(),
                              );
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                analyze(
                                  s.start,
                                  s.end,
                                  e.currentTarget.getBoundingClientRect(),
                                );
                              }
                            }}
                          >
                            {s.text}
                          </span>
                        ) : (
                          s.text
                        ),
                      )}
                    </div>
                    {selection && (
                      <button
                        className="selection-action primary"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() =>
                          analyze(
                            selection.start,
                            selection.end,
                            selection.rect,
                          )
                        }
                      >
                        Проанализировать выражение
                      </button>
                    )}
                    <div className="reader-end">
                      ✧<p>Ещё одна история стала понятнее.</p>
                    </div>
                  </>
                ) : (
                  <Empty
                    title="Начните с первого текста"
                    text="Добавьте его в библиотеку, чтобы открыть читалку."
                  />
                )}
              </>
            )}
            {view === "/vocabulary" && (
              <>
                <div className="eyebrow">СЛОВА, КОТОРЫЕ СТАЛИ ВАШИМИ</div>
                <section className="page-heading">
                  <div>
                    <h1>
                      Мой <em>словарь.</em>
                    </h1>
                    <p>
                      Не просто перевод. Ваши слова с их историями и контекстом.
                    </p>
                  </div>
                  <div className="button-row">
                    <button
                      className="secondary"
                      onClick={() => exportWords("json")}
                    >
                      ↓ JSON
                    </button>
                    <button
                      className="secondary"
                      onClick={() => exportWords("csv")}
                    >
                      ↓ CSV
                    </button>
                  </div>
                </section>
                <div className="vocab-tools">
                  <label className="search">
                    <span>⌕</span>
                    <input
                      aria-label="Поиск слов"
                      placeholder="Слово или перевод…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Фильтр языка"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">Все языки</option>
                    {Object.entries(langs).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Сортировка"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="new">Сначала новые</option>
                    <option value="old">Сначала старые</option>
                  </select>
                </div>
                <div className="vocab-list">
                  {words.map((e) => (
                    <article className="vocab-row" key={e.id}>
                      <button
                        className="word-open"
                        onClick={() => {
                          requestId.current++;
                          setExpanded(null);
                          setExpandedError(null);
                          setExpandedLoading(false);
                          setBusy(false);
                          setAnchor({ x: window.innerWidth - 470, y: 140 });
                          setCard({
                            analysis: e.analysis,
                            demo: e.demo,
                            document_id: e.document_id,
                            source: { vocabulary_entry_id: e.id },
                          });
                        }}
                      >
                        <span className="word-language">
                          {e.analysis.language.toUpperCase()}
                        </span>
                        <div>
                          <h3>
                            {e.analysis.original_word}{" "}
                            <small>{e.analysis.lemma}</small>
                          </h3>
                          <p>{e.analysis.contextual_translation_ru}</p>
                          <blockquote>
                            {e.analysis.original_sentence}
                          </blockquote>
                          {e.demo && (
                            <small className="demo-tag">
                              Тестовая карточка
                            </small>
                          )}
                        </div>
                      </button>
                      <div className="vocab-actions">
                        <small>
                          {new Date(e.created_at).toLocaleDateString("ru-RU")}
                        </small>
                        {state.docs.some((d) => d.id === e.document_id) && (
                          <Link
                            href="/read"
                            onClick={() =>
                              setState((s) => ({
                                ...s,
                                selected: e.document_id || "",
                              }))
                            }
                          >
                            К тексту ↗
                          </Link>
                        )}
                        <button
                          aria-label={
                            "Удалить слово " + e.analysis.original_word
                          }
                          onClick={() => deleteEntry(e.id)}
                        >
                          Удалить
                        </button>
                      </div>
                    </article>
                  ))}
                  {!words.length && (
                    <Empty
                      title="Здесь будут ваши открытия"
                      text="Нажмите на слово в читалке и сохраните его разбор."
                    />
                  )}
                </div>
              </>
            )}
            {view === "/settings" && (
              <>
                <div className="eyebrow">УДОБНО ИМЕННО ВАМ</div>
                <h1>
                  Настройки<em>.</em>
                </h1>
                <div className="settings-grid">
                  <section className="settings-card">
                    <h2>Ваш аккаунт</h2>
                    {session ? (
                      <>
                        <p>
                          Вы вошли как {session.user.email}. Библиотека и
                          словарь синхронизируются через Supabase.
                        </p>
                        <button
                          className="secondary"
                          onClick={async () => {
                            requestId.current++;
                            setCard(null);
                            await clearScope(scope);
                            await db?.auth.signOut();
                            setState(empty);
                          }}
                        >
                          Выйти
                        </button>
                      </>
                    ) : (
                      <>
                        <p>
                          Без аккаунта работает деморежим. Для настоящего ИИ и
                          синхронизации войдите по электронной почте.
                        </p>
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (!db) {
                              setNotice(
                                "Supabase не настроен. См. README для подключения.",
                              );
                              return;
                            }
                            const { error } = await db.auth.signInWithOtp({
                              email,
                              options: {
                                emailRedirectTo: location.origin + "/settings",
                              },
                            });
                            setNotice(
                              error
                                ? "Не удалось отправить письмо. Проверьте адрес и настройки Supabase."
                                : "Письмо отправлено. Откройте ссылку на этом устройстве.",
                            );
                          }}
                        >
                          <label>
                            Email
                            <input
                              type="email"
                              required
                              placeholder="you@example.com"
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                            />
                          </label>
                          <button className="primary">
                            Получить ссылку для входа
                          </button>
                        </form>
                      </>
                    )}
                  </section>
                  <section className="settings-card">
                    <h2>Комфортное чтение</h2>
                    <label>
                      Тема
                      <select
                        aria-label="Тема"
                        value={state.prefs.theme}
                        onChange={(e) =>
                          preferences({
                            ...state.prefs,
                            theme: e.target.value as Prefs["theme"],
                          })
                        }
                      >
                        <option value="light">Светлая</option>
                        <option value="dark">Тёмная</option>
                        <option value="system">Как на устройстве</option>
                      </select>
                    </label>
                    <label>
                      Размер шрифта: {state.prefs.font_size} px
                      <input
                        aria-label="Размер шрифта"
                        type="range"
                        min="16"
                        max="32"
                        value={state.prefs.font_size}
                        onChange={(e) =>
                          preferences({
                            ...state.prefs,
                            font_size: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  </section>
                  <section className="settings-card">
                    <h2>Lexora всегда рядом</h2>
                    <p>
                      Установите приложение для удобного доступа. Ранее открытые
                      тексты можно читать без интернета.
                    </p>
                    {install ? (
                      <button
                        className="primary"
                        onClick={() => install.prompt()}
                      >
                        Установить Lexora
                      </button>
                    ) : (
                      <p className="muted">
                        Android: меню Chrome → «Установить приложение». На
                        компьютере: значок установки в адресной строке. Нужен
                        HTTPS.
                      </p>
                    )}
                  </section>
                  <section className="settings-card">
                    <h2>Ваши данные</h2>
                    <p>
                      Тексты отправляются в Supabase после входа. OpenAI
                      получает только выбранный фрагмент и ограниченный контекст
                      при запросе анализа.
                    </p>
                    <button className="danger" onClick={deleteData}>
                      Удалить все мои данные
                    </button>
                    <p className="muted">
                      Удаляет библиотеку, словарь, настройки и локальный кэш.
                      Учётная запись остаётся.
                    </p>
                  </section>
                </div>
              </>
            )}
          </div>
        )}
        <footer className="main-footer">
          <span>lexora.</span>
          <span>Читайте с интересом. Учите с удовольствием.</span>
        </footer>
      </main>
      {adding && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Новый текст"
          >
            <button
              className="close"
              aria-label="Закрыть"
              onClick={() => setAdding(false)}
            >
              ×
            </button>
            <div className="eyebrow">НОВАЯ ИСТОРИЯ</div>
            <h2>Что будем читать?</h2>
            <p>Вставьте любой текст. Черновик сохраняется автоматически.</p>
            <form onSubmit={addDocument}>
              <label>
                Название
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Название вашей истории"
                />
              </label>
              <label>
                Язык
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value as typeof lang)}
                >
                  {Object.entries(langs).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Текст
                <textarea
                  required
                  maxLength={100000}
                  rows={9}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Здесь начинается ваша история…"
                />
              </label>
              <small className="muted">
                {content.length.toLocaleString("ru-RU")} / 100 000 символов ·
                обычный текст
              </small>
              <button className="primary" disabled={saving}>
                {saving ? "Сохраняем…" : "Сохранить текст"}
              </button>
            </form>
          </section>
        </div>
      )}
      {(card || busy) && (
        <AnalysisCard
          analysis={card?.analysis || null}
          demo={card?.demo ?? !session}
          loading={busy}
          expanded={expanded}
          expandedLoading={expandedLoading}
          expandedError={expandedError}
          onExpand={expandAnalysis}
          onSave={saveWord}
          saving={saving}
          saved={
            !!card &&
            state.entries.some(
              (e) =>
                e.document_id === card.document_id &&
                e.analysis.original_word === card.analysis.original_word &&
                e.analysis.original_sentence ===
                  card.analysis.original_sentence,
            )
          }
          onClose={() => {
            requestId.current++;
            setCard(null);
            setBusy(false);
          }}
          anchored={view === "/read"}
          anchor={anchor}
        />
      )}
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span>✧</span>
      <h2>{title}</h2>
      <p>{text}</p>
      <Link className="secondary" href="/library">
        В библиотеку →
      </Link>
    </div>
  );
}
