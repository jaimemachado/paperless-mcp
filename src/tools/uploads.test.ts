import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type {
  CallToolResult,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { Uploads } from "../uploads";
import { registerUploadTools } from "./uploads";

class TestTransport implements Transport {
  peer?: TestTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function parseToolText(result: CallToolResult) {
  const item = result.content?.[0];
  if (!item || item.type !== "text")
    throw new Error("Expected text tool response");
  return JSON.parse(item.text);
}

function fakeUploads() {
  const requested: unknown[] = [];
  const uploads = {
    request: (metadata: unknown) => {
      requested.push(metadata);
      return {
        upload_id: "id1",
        url: "https://upload.example.test/upload/tok",
        expires_at: "2026-10-31T10:15:00.000Z",
        max_megabytes: 50,
      };
    },
    status: async (id: string) => ({ status: "pending", id }),
  } as unknown as Uploads;
  return { uploads, requested };
}

// The api of the MCP request: it has the token of the caller.
function callerApi(valid: boolean) {
  const paths: string[] = [];
  const api = {
    request: async (path: string) => {
      paths.push(path);
      if (!valid) throw new Error("Invalid token.");
      return {};
    },
  } as unknown as PaperlessAPI;
  return { api, paths };
}

async function withClient(
  api: PaperlessAPI,
  uploads: Uploads,
  run: (client: Client) => Promise<void>
) {
  const server = new McpServer({ name: "upload-test", version: "1.0.0" });
  registerUploadTools(server, api, uploads);
  const client = new Client({ name: "upload-test-client", version: "1.0.0" });
  const clientTransport = new TestTransport();
  const serverTransport = new TestTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("request_upload gives a link with a curl command, and check_upload reports it", async () => {
  const { uploads, requested } = fakeUploads();
  const { api, paths } = callerApi(true);

  await withClient(api, uploads, async (client) => {
    const requestResult = (await client.callTool({
      name: "request_upload",
      arguments: {
        title: "Tax letter",
        tags: [4],
        correspondent: 3,
        document_type: 2,
      },
    })) as CallToolResult;
    assert.ok(!requestResult.isError);
    const link = parseToolText(requestResult);
    assert.equal(link.upload_id, "id1");
    assert.equal(link.url, "https://upload.example.test/upload/tok");
    assert.equal(
      link.curl,
      "curl -F file=@<path> https://upload.example.test/upload/tok"
    );
    assert.deepEqual(requested, [
      { title: "Tax letter", tags: [4], correspondent: 3, document_type: 2 },
    ]);

    const checkResult = (await client.callTool({
      name: "check_upload",
      arguments: { upload_id: "id1" },
    })) as CallToolResult;
    assert.deepEqual(parseToolText(checkResult), {
      status: "pending",
      id: "id1",
    });
  });
  // The token of the caller needs view on tags, but not view on the UI settings.
  assert.deepEqual(paths, ["/tags/?page_size=1", "/tags/?page_size=1"]);
});

test("request_upload and check_upload refuse a caller whose Paperless token is not valid", async () => {
  const { uploads, requested } = fakeUploads();
  const { api } = callerApi(false);

  await withClient(api, uploads, async (client) => {
    const result = (await client.callTool({
      name: "request_upload",
      arguments: {},
    })) as CallToolResult;
    assert.ok(result.isError);
    const check = (await client.callTool({
      name: "check_upload",
      arguments: { upload_id: "id1" },
    })) as CallToolResult;
    assert.ok(check.isError);
  });
  assert.deepEqual(requested, []);
});
