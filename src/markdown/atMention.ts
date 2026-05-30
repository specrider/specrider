import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { rankPlans } from "../search/rankPlans";
import type { Plan } from "../types";

/** Characters that may follow `@` as part of a project-relative path:
 *  word chars plus `/`, `-`, `_`, and `.`. Also the regex stays short
 *  so the worst-case scan in `matchBefore` is cheap. */
const AT_MENTION_RE = /@[\w./-]*/;

const MAX_SUGGESTIONS = 30;
const EMPTY_QUERY_LIMIT = 20;

/**
 * Autocomplete extension that mirrors Claude Code's `@` file-reference
 * UI: typing `@` opens a popup of project plans (anywhere `.md` files
 * live under the configured plans root) ranked by the same fuzzy
 * scorer that powers ⌘T QuickSwitch. Accepting a row replaces the
 * `@query` with `@<plan.path>` so the inserted reference is the
 * project-relative path — the same form Claude Code reads.
 *
 * `getPlans` is read at completion time so file-watcher updates flow
 * through without rebuilding the editor.
 */
export function atMentionExtension(getPlans: () => Plan[]): Extension {
  const source = (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(AT_MENTION_RE);
    if (!match) return null;
    // Reject `foo@bar.com`-style mid-word `@`. Only fire when the `@`
    // sits at the start of the line or right after whitespace.
    const lineFrom = context.state.doc.lineAt(match.from).from;
    if (match.from > lineFrom) {
      const before = context.state.doc.sliceString(match.from - 1, match.from);
      if (!/\s/.test(before)) return null;
    }
    const query = match.text.slice(1);
    const ranked = rankPlans(query, getPlans(), {
      limit: MAX_SUGGESTIONS,
      emptyQueryLimit: EMPTY_QUERY_LIMIT,
    });
    if (ranked.length === 0) return null;

    const options: Completion[] = ranked.map(({ plan }) => {
      // `label` is what CM's built-in fuzzy filter scores against as
      // the user keeps typing past the initial `@`. We want both the
      // title and the path to count as "matchable" text so typing
      // either still narrows the list.
      const label = `@${plan.title} ${plan.path}`;
      return {
        label,
        displayLabel: plan.title,
        detail: plan.path,
        type: "file",
        apply: (view, _completion, from, to) => {
          // Insert as a Markdown link relative to the active doc when
          // possible, falling back to the project-relative path. The
          // editor doesn't know its own path, so we emit a path
          // relative to the project root — `onLinkClick` already
          // resolves both forms.
          const insert = `[${plan.title}](${plan.path})`;
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
          });
        },
      };
    });

    return {
      from: match.from,
      to: match.to,
      options,
      // Keep the popup open while the user keeps typing path chars.
      validFor: AT_MENTION_RE,
    };
  };

  return [
    autocompletion({
      override: [source],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: false,
    }),
    EditorView.baseTheme(atMentionTheme),
  ];
}

const atMentionTheme = {
  ".cm-tooltip.cm-tooltip-autocomplete": {
    background: "var(--paper)",
    border: "1px solid var(--rule)",
    borderRadius: "8px",
    boxShadow: "0 12px 32px -6px color-mix(in oklch, black 28%, transparent)",
    overflow: "hidden",
    padding: "2px 0",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    maxHeight: "260px",
    margin: "0",
    minWidth: "320px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "5px 12px",
    color: "var(--ink)",
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    lineHeight: "1.3",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--accent-soft)",
    color: "var(--ink)",
  },
  ".cm-completionLabel": {
    fontWeight: "500",
    color: "var(--ink)",
    flex: "0 1 auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-completionDetail": {
    color: "var(--ink-3)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    fontStyle: "normal",
    flex: "1 1 auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "right",
  },
  ".cm-completionMatchedText": {
    color: "var(--accent-fg)",
    textDecoration: "none",
    fontWeight: "600",
  },
};
