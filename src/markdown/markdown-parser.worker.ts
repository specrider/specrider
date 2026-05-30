import type { Root } from "mdast";
import { extractOutline, totalProgress } from "./outline";
import type { MarkdownParseResult } from "./parseInWorker";
import { buildPlanParser } from "./parserPipeline";

interface ParseRequest {
  id: number;
  source: string;
}

interface ParseResponse {
  id: number;
  result?: MarkdownParseResult;
  error?: string;
}

const processor = buildPlanParser();

const workerSelf = globalThis as unknown as {
  postMessage: (message: ParseResponse) => void;
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
};

workerSelf.onmessage = (event) => {
  const { id, source } = event.data;
  try {
    const tree = processor.parse(source) as Root;
    const outline = extractOutline(tree);
    const progress = totalProgress(outline);
    workerSelf.postMessage({ id, result: { tree, outline, progress } });
  } catch (error) {
    workerSelf.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
