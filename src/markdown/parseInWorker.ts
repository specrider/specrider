import type { Root } from "mdast";
import type { OutlineNode } from "../types";

export interface MarkdownParseResult {
  tree: Root;
  outline: OutlineNode[];
  progress: { done: number; total: number };
}

interface ParseRequest {
  id: number;
  source: string;
}

interface ParseResponse {
  id: number;
  result?: MarkdownParseResult;
  error?: string;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  {
    resolve: (result: MarkdownParseResult) => void;
    reject: (error: Error) => void;
  }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./markdown-parser.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<ParseResponse>) => {
    const { id, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) {
      entry.reject(new Error(error));
    } else if (result) {
      entry.resolve(result);
    } else {
      entry.reject(new Error("Markdown parser worker returned no result"));
    }
  };
  worker.onerror = (event) => {
    const message = event.message || "Markdown parser worker failed";
    for (const [, entry] of pending) entry.reject(new Error(message));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function parseInWorker(source: string): Promise<MarkdownParseResult> {
  const id = nextId++;
  const request: ParseRequest = { id, source };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(request);
  });
}
