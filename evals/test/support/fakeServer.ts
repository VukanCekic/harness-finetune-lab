/**
 * A scripted OpenAI-compatible server, so the real harness can be run end to
 * end without a model: each POST /v1/chat/completions plays the next reply
 * (the last one repeats). Used by the end-to-end tests and for reproducing
 * infrastructure failures by hand.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Reply =
  | { kind: "text"; content: string; reasoning?: string }
  | { kind: "tool"; name: string; args: Record<string, unknown>; content?: string }
  /** A non-200 answer, e.g. the HTTP 400 a bad request gets. */
  | { kind: "http"; status: number; body?: string }
  /** One chunk, then silence: a stalled server. */
  | { kind: "stall" };

export interface FakeServer {
  url: string;
  /** Parsed request bodies, in order. */
  requests: any[];
  close(): Promise<void>;
}

const sse = (res: http.ServerResponse, payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
const chunk = (delta: object, finish: string | null = null) => ({
  id: "fake",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }]
});

export async function fakeServer(script: Reply[], model = "fake-model"): Promise<FakeServer> {
  const requests: any[] = [];
  let next = 0;
  const open = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && /\/models$/.test(req.url ?? "")) {
      res.setHeader("Content-Type", "application/json");
      const entry = { id: model, object: "model", type: "llm", quantization: "Q8_0", loaded_context_length: 40960 };
      res.end(JSON.stringify(req.url!.includes("/api/v0") ? { object: "list", data: [entry] } : { data: [{ id: model }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const reply = script[Math.min(next++, script.length - 1)];
      if (reply.kind === "http") {
        res.statusCode = reply.status;
        res.setHeader("Content-Type", "application/json");
        res.end(reply.body ?? JSON.stringify({ error: { message: "bad request" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      open.add(res);
      res.on("close", () => open.delete(res));
      sse(res, chunk({ role: "assistant", content: "" }));
      if (reply.kind === "stall") return; // never finishes; the harness's stall watchdog has to notice
      if (reply.kind === "text") {
        if (reply.reasoning) sse(res, chunk({ reasoning_content: reply.reasoning }));
        sse(res, chunk({ content: reply.content }));
        sse(res, chunk({}, "stop"));
      } else {
        if (reply.content) sse(res, chunk({ content: reply.content }));
        const call = { index: 0, id: `call_${next}`, type: "function", function: { name: reply.name, arguments: "" } };
        sse(res, chunk({ tool_calls: [call] }));
        sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] }));
        sse(res, chunk({}, "tool_calls"));
      }
      sse(res, { id: "fake", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
      })
  };
}

// Run by hand: `tsx evals/test/support/fakeServer.ts http400|stall|text`
if (process.argv[1]?.endsWith("fakeServer.ts") && process.argv[2]) {
  const scripts: Record<string, Reply[]> = {
    http400: [{ kind: "http", status: 400 }],
    stall: [{ kind: "stall" }],
    text: [{ kind: "text", content: "done" }]
  };
  const server = await fakeServer(scripts[process.argv[2]] ?? scripts.text);
  console.log(server.url);
}
