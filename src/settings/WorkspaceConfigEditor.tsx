import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  type Extension,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  readWorkspaceConfigSource,
  writeWorkspaceConfigSource,
} from "../tauri/api";

const jsonEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--ink)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: "1.45",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "10px 0",
    minHeight: "100%",
    caretColor: "var(--ink)",
  },
  ".cm-line": {
    padding: "0 12px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--paper-2)",
    borderRight: "1px solid var(--rule-soft)",
    color: "var(--ink-4)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 10px",
    minWidth: "28px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--ink-2)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--accent) 7%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--ink)",
    borderLeftWidth: "1.5px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "color-mix(in oklch, var(--accent) 32%, transparent)",
    },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--ink)",
  },
});

const jsonKeyDeco = Decoration.mark({ class: "cm-json-key" });
const jsonStringDeco = Decoration.mark({ class: "cm-json-string" });
const jsonNumberDeco = Decoration.mark({ class: "cm-json-number" });
const jsonBooleanDeco = Decoration.mark({ class: "cm-json-boolean" });
const jsonNullDeco = Decoration.mark({ class: "cm-json-null" });
const jsonPunctuationDeco = Decoration.mark({ class: "cm-json-punctuation" });
const jsonErrorDeco = Decoration.mark({ class: "cm-json-error" });

const jsonHighlightExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildJsonDecorations(view.state.doc.toString());
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildJsonDecorations(update.state.doc.toString());
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

const jsonEditorBaseExtensions: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentUnit.of("  "),
  bracketMatching(),
  highlightActiveLine(),
  jsonHighlightExtension,
  jsonEditorTheme,
  keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
];

function buildJsonDecorations(source: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let idx = 0;

  const add = (from: number, to: number, decoration: Decoration) => {
    if (to > from) builder.add(from, to, decoration);
  };

  const keywordAt = (word: string) => {
    if (!source.startsWith(word, idx)) return false;
    const next = source[idx + word.length] ?? "";
    return !/[A-Za-z0-9_$]/.test(next);
  };

  while (idx < source.length) {
    const ch = source[idx];

    if (/\s/.test(ch)) {
      while (idx < source.length && /\s/.test(source[idx])) idx += 1;
      continue;
    }

    if (ch === '"') {
      const start = idx;
      idx += 1;
      let escaped = false;
      while (idx < source.length) {
        const current = source[idx];
        idx += 1;
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === '"') {
          break;
        }
      }
      let lookahead = idx;
      while (lookahead < source.length && /\s/.test(source[lookahead])) {
        lookahead += 1;
      }
      add(start, idx, source[lookahead] === ":" ? jsonKeyDeco : jsonStringDeco);
      continue;
    }

    const numberMatch = source
      .slice(idx)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      add(idx, idx + numberMatch[0].length, jsonNumberDeco);
      idx += numberMatch[0].length;
      continue;
    }

    if (keywordAt("true") || keywordAt("false")) {
      const word = source.startsWith("true", idx) ? "true" : "false";
      add(idx, idx + word.length, jsonBooleanDeco);
      idx += word.length;
      continue;
    }

    if (keywordAt("null")) {
      add(idx, idx + 4, jsonNullDeco);
      idx += 4;
      continue;
    }

    if ("{}[]:,".includes(ch)) {
      add(idx, idx + 1, jsonPunctuationDeco);
      idx += 1;
      continue;
    }

    add(idx, idx + 1, jsonErrorDeco);
    idx += 1;
  }

  return builder.finish();
}

function WorkspaceJsonEditor({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const editableCompartment = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount CodeMirror once; value and disabled are synchronized by the effects below.
  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        ...jsonEditorBaseExtensions,
        EditorView.contentAttributes.of({
          id,
          "aria-label": "Workspace config JSON",
        }),
        editableCompartment.current.of([
          EditorState.readOnly.of(disabled),
          EditorView.editable.of(!disabled),
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.current.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
      ]),
    });
  }, [disabled]);

  return <div ref={hostRef} className="workspace-json-editor" />;
}

export function WorkspaceConfigEditor({
  plansRoot,
  editorId,
}: {
  plansRoot: string | null;
  editorId: string;
}) {
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = source !== savedSource;
  const syntaxError = useMemo(() => {
    if (!source.trim()) return "JSON is required.";
    try {
      JSON.parse(source);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [source]);

  const load = useCallback(async () => {
    if (!plansRoot) {
      setSource("");
      setSavedSource("");
      setPath(null);
      setExists(false);
      setError(null);
      setNotice(null);
      return;
    }
    setLoading(true);
    try {
      setError(null);
      const snapshot = await readWorkspaceConfigSource(plansRoot);
      setSource(snapshot.source);
      setSavedSource(snapshot.source);
      setPath(snapshot.path);
      setExists(snapshot.exists);
      setNotice(
        snapshot.exists
          ? null
          : "This is the basic config template. Save to create it.",
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [plansRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const onFormat = () => {
    try {
      setSource(`${JSON.stringify(JSON.parse(source), null, 2)}\n`);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSave = async () => {
    if (!plansRoot || saving || syntaxError || (exists && !dirty)) return;
    setSaving(true);
    try {
      setError(null);
      const snapshot = await writeWorkspaceConfigSource(source, plansRoot);
      const nextSource = source.endsWith("\n") ? source : `${source}\n`;
      setSource(nextSource);
      setSavedSource(nextSource);
      setPath(snapshot.path);
      setExists(true);
      setNotice("Saved workspace config.");
    } catch (err) {
      setError(String(err));
      setNotice(null);
    } finally {
      setSaving(false);
    }
  };

  if (!plansRoot) {
    return (
      <div className="workspace-config-editor">
        <span className="settings-static">
          Open a workspace in the main app window first.
        </span>
      </div>
    );
  }

  return (
    <div className="workspace-config-editor">
      <div className="workspace-config-editor-meta">
        <span className="settings-static">
          {path ?? ".specrider/workspace.json"}
        </span>
        <span className="workspace-config-editor-state">
          {loading ? "Loading" : exists ? "File exists" : "Not created yet"}
          {dirty ? " · unsaved edits" : ""}
        </span>
      </div>
      <WorkspaceJsonEditor
        id={editorId}
        value={source}
        disabled={loading || saving}
        onChange={(next) => {
          setSource(next);
          setNotice(null);
        }}
      />
      <div className="workspace-config-editor-actions">
        <button
          type="button"
          className="settings-action primary"
          onClick={() => void onSave()}
          disabled={loading || saving || !!syntaxError || (exists && !dirty)}
        >
          {saving ? "Saving…" : exists ? "Save config" : "Create config"}
        </button>
        <button
          type="button"
          className="settings-action secondary"
          onClick={onFormat}
          disabled={loading || saving || !!syntaxError}
        >
          Format JSON
        </button>
        <button
          type="button"
          className="settings-action secondary"
          onClick={() => void load()}
          disabled={loading || saving}
        >
          Reload from disk
        </button>
      </div>
      {(syntaxError || error || notice) && (
        <div
          className={`workspace-config-editor-message ${
            syntaxError || error ? "error" : ""
          }`}
          role="status"
        >
          {syntaxError ?? error ?? notice}
        </div>
      )}
    </div>
  );
}
