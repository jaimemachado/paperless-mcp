import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import express from "express";
import { PaperlessAPI } from "./api/PaperlessAPI";
import { Uploads, uploadConfig } from "./uploads";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const DONE_TASK = {
  task_id: "task-1",
  status: "SUCCESS",
  related_document: "123",
  result: "Success. New document id 123 created",
};

interface Posted {
  document: Buffer;
  filename: string;
  metadata: Record<string, unknown>;
}

interface FakeOptions {
  fail?: boolean;
  tagVisible?: boolean;
  tasks?: unknown[];
  hold?: Promise<void>;
  maxBytes?: number;
}

function fakeApi({
  fail = false,
  tagVisible = true,
  tasks = [DONE_TASK],
  hold,
}: FakeOptions) {
  const posted: Posted[] = [];
  const api = {
    postDocument: async (
      document: Buffer | Readable,
      filename: string,
      metadata: Record<string, unknown>
    ) => {
      const bytes = Buffer.isBuffer(document)
        ? document
        : Buffer.concat(await document.toArray());
      posted.push({ document: bytes, filename, metadata });
      if (hold) await hold;
      if (fail) throw new Error("Paperless is down");
      return "task-1";
    },
    request: async (path: string) => {
      if (path === "/tags/?name__iexact=via-mcp") {
        return tagVisible
          ? { count: 1, results: [{ id: 99, name: "via-mcp" }] }
          : { count: 0, results: [] };
      }
      if (path === "/tasks/?task_id=task-1") return tasks;
      throw new Error(`unexpected request ${path}`);
    },
  } as unknown as PaperlessAPI;
  return { api, posted };
}

async function withUploads(
  options: FakeOptions,
  run: (s: {
    uploads: Uploads;
    posted: Posted[];
    local: (url: string) => string;
    advance: (ms: number) => void;
  }) => Promise<void>
) {
  const { api, posted } = fakeApi(options);
  let now = 1_000_000;
  const uploads = new Uploads({
    api,
    publicUrl: "https://upload.example.test/",
    maxBytes: options.maxBytes,
    now: () => now,
  });
  const app = express();
  app.use(uploads.router());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({
      uploads,
      posted,
      // The link points to the public host; the test sends it to the local server.
      local: (url: string) => base + new URL(url).pathname,
      advance: (ms: number) => {
        now += ms;
      },
    });
  } finally {
    server.close();
  }
}

function form(content: Buffer | string, name = "letter.pdf", field = "file") {
  const body = new FormData();
  body.append(field, new Blob([content]), name);
  return { method: "POST", body };
}

describe("upload links", () => {
  test("request gives a link with a long random token that expires in 15 minutes", () =>
    withUploads({}, async ({ uploads }) => {
      const a = uploads.request({});
      const b = uploads.request({});
      assert.match(
        a.url,
        /^https:\/\/upload\.example\.test\/upload\/[A-Za-z0-9_-]{43}$/
      );
      assert.notEqual(a.url, b.url);
      assert.notEqual(a.upload_id, b.upload_id);
      assert.ok(
        !a.url.includes(a.upload_id),
        "the upload ID must not be the token"
      );
      assert.equal(
        a.expires_at,
        new Date(1_000_000 + 15 * 60_000).toISOString()
      );
    }));

  test("a POSTed PDF goes to Paperless with the stored values and the via-mcp tag", () =>
    withUploads({}, async ({ uploads, posted, local }) => {
      const link = uploads.request({
        title: "Tax letter",
        tags: [4, 7],
        correspondent: 3,
        document_type: 2,
      });
      assert.equal((await uploads.status(link.upload_id)).status, "pending");

      const res = await fetch(local(link.url), form(PDF));
      assert.equal(res.status, 200, await res.text());

      assert.equal(posted.length, 1);
      assert.deepEqual(posted[0].document, PDF);
      assert.equal(posted[0].filename, "letter.pdf");
      assert.deepEqual(posted[0].metadata, {
        title: "Tax letter",
        tags: ["4", "7", "99"],
        correspondent: "3",
        document_type: "2",
      });
      assert.deepEqual(await uploads.status(link.upload_id), {
        status: "SUCCESS",
        task_id: "task-1",
        document_id: 123,
        result: "Success. New document id 123 created",
      });
    }));

  test("a link works one time only", () =>
    withUploads({}, async ({ uploads, posted, local }) => {
      const link = uploads.request({});
      assert.equal((await fetch(local(link.url), form(PDF))).status, 200);

      const again = await fetch(local(link.url), form(PDF));
      assert.equal(again.status, 404);
      assert.equal(posted.length, 1);
    }));

  test("an expired link is refused", () =>
    withUploads({}, async ({ uploads, posted, local, advance }) => {
      const link = uploads.request({});
      advance(15 * 60_000 + 1);

      assert.equal((await fetch(local(link.url), form(PDF))).status, 404);
      assert.equal((await fetch(local(link.url))).status, 404);
      assert.equal(posted.length, 0);
      assert.equal((await uploads.status(link.upload_id)).status, "expired");
    }));

  test("an unknown token is refused", () =>
    withUploads({}, async ({ local }) => {
      const url = local("https://x/upload/nope");
      assert.equal((await fetch(url, form(PDF))).status, 404);
      const get = await fetch(url);
      assert.equal(get.status, 404);
      assert.equal(get.headers.get("cache-control"), "no-store");
    }));

  test("GET gives the form for a live link, with strict headers, and does not use it", () =>
    withUploads({}, async ({ uploads, local }) => {
      const link = uploads.request({});
      const res = await fetch(local(link.url));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(
        res.headers.get("content-security-policy") ?? "",
        /default-src 'none'.*form-action 'self'/
      );
      const html = await res.text();
      assert.match(
        html,
        /<form[^>]+method="post"[^>]+enctype="multipart\/form-data"/
      );
      assert.match(html, /<input[^>]+type="file"[^>]+name="file"/);
      assert.equal((await fetch(local(link.url), form(PDF))).status, 200);
    }));

  test("the file name loses its directory part and the characters that break a header", () =>
    withUploads({}, async ({ uploads, posted, local }) => {
      for (const name of ["../../etc/passwd.pdf", "C:\\x\\a.pdf", "Rä.pdf"]) {
        const link = uploads.request({});
        assert.equal((await fetch(local(link.url), form(PDF, name))).status, 200);
      }
      // fetch escapes a quote and a line break; the RFC 5987 form carries them as they are.
      const link = uploads.request({});
      const raw = await fetch(local(link.url), {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=b" },
        body:
          "--b\r\nContent-Disposition: form-data; name=\"file\"; filename*=UTF-8''R%C3%A4%22ch%0D%0Anung.pdf\r\n\r\n" +
          PDF.toString("latin1") +
          "\r\n--b--\r\n",
      });
      assert.equal(raw.status, 200);
      assert.deepEqual(
        posted.map((p) => p.filename),
        ["passwd.pdf", "a.pdf", "Rä.pdf", "Rä_ch__nung.pdf"]
      );
    }));
});

describe("refused uploads use the link", () => {
  async function refused(
    options: FakeOptions,
    send: (url: string) => Promise<Response>,
    code: number
  ) {
    await withUploads(options, async ({ uploads, posted, local }) => {
      const link = uploads.request({});
      const res = await send(local(link.url));
      assert.equal(res.status, code);
      assert.doesNotMatch(
        await res.text(),
        /at |node_modules/,
        "no stack trace"
      );
      assert.equal(posted.length, 0);
      assert.equal((await uploads.status(link.upload_id)).status, "failed");
      assert.equal((await fetch(local(link.url), form(PDF))).status, 404);
    });
  }

  test("a file that is not a PDF or an image", () =>
    refused(
      {},
      (url) => fetch(url, form("#!/bin/sh\necho hi\n", "x.pdf")),
      415
    ));

  test("an MP4 file, which has an ftyp box but is not HEIF", () =>
    refused(
      {},
      (url) =>
        fetch(
          url,
          form(
            Buffer.concat([
              Buffer.from("00000018", "hex"),
              Buffer.from("ftypisom"),
            ]),
            "a.heic"
          )
        ),
      415
    ));

  test("a request with no field file", () =>
    refused({}, (url) => fetch(url, form(PDF, "x.pdf", "document")), 400));

  test("a body that is not multipart/form-data", () =>
    refused(
      {},
      (url) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"file": "x"}',
        }),
      400
    ));

  test("a multipart body that stops before its end", () =>
    refused(
      {},
      (url) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=b" },
          body: '--b\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n%PDF-1.4',
        }),
      400
    ));

  test("a file over the size limit", () =>
    refused(
      { maxBytes: 1024 },
      (url) => fetch(url, form(Buffer.concat([PDF, Buffer.alloc(2048)]))),
      413
    ));

  test("a body that says it is larger than the limit", () =>
    refused(
      { maxBytes: 1024 },
      (url) => fetch(url, form(Buffer.concat([PDF, Buffer.alloc(200 * 1024)]))),
      413
    ));
});

describe("upload status", () => {
  test("a failure of Paperless gives 502 without its details, and the status failed with them", () =>
    withUploads({ fail: true }, async ({ uploads, local }) => {
      const link = uploads.request({});
      const res = await fetch(local(link.url), form(PDF));
      assert.equal(res.status, 502);
      assert.doesNotMatch(await res.text(), /Paperless is down/);
      const status = await uploads.status(link.upload_id);
      assert.equal(status.status, "failed");
      assert.match(String(status.error), /Paperless is down/);
    }));

  test("the upload fails when the upload user cannot see the via-mcp tag", () =>
    withUploads({ tagVisible: false }, async ({ uploads, posted, local }) => {
      const link = uploads.request({});
      assert.equal((await fetch(local(link.url), form(PDF))).status, 502);
      assert.equal(posted.length, 0);
      const status = await uploads.status(link.upload_id);
      assert.equal(status.status, "failed");
      assert.match(String(status.error), /via-mcp/);
    }));

  test("submitted while Paperless does not know the task yet", () =>
    withUploads({ tasks: [] }, async ({ uploads, local }) => {
      const link = uploads.request({});
      assert.equal((await fetch(local(link.url), form(PDF))).status, 200);
      assert.deepEqual(await uploads.status(link.upload_id), {
        status: "submitted",
        task_id: "task-1",
      });
    }));

  test("document_id is null while the task has no document", () =>
    withUploads(
      {
        tasks: [
          {
            task_id: "task-1",
            status: "STARTED",
            related_document: null,
            result: null,
          },
        ],
      },
      async ({ uploads, local }) => {
        const link = uploads.request({});
        assert.equal((await fetch(local(link.url), form(PDF))).status, 200);
        assert.deepEqual(await uploads.status(link.upload_id), {
          status: "STARTED",
          task_id: "task-1",
          document_id: null,
          result: null,
        });
      }
    ));

  test("receiving while the file goes to Paperless", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withUploads({ hold }, async ({ uploads, posted, local }) => {
      const link = uploads.request({});
      const upload = fetch(local(link.url), form(PDF));
      for (let i = 0; i < 100 && posted.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(await uploads.status(link.upload_id), {
        status: "receiving",
      });
      release();
      assert.equal((await upload).status, 200);
    });
  });

  test("an unknown upload ID has the status unknown", () =>
    withUploads({}, async ({ uploads }) => {
      assert.deepEqual(await uploads.status("nope"), { status: "unknown" });
    }));

  test("old links are removed one day after they expire", () =>
    withUploads({}, async ({ uploads, advance }) => {
      const old = uploads.request({});
      advance(15 * 60_000 + 60_000);
      uploads.request({});
      assert.equal((await uploads.status(old.upload_id)).status, "expired");

      advance(24 * 60 * 60_000);
      uploads.request({});
      assert.deepEqual(await uploads.status(old.upload_id), {
        status: "unknown",
      });
    }));

  test("PDF files and the usual image types are accepted", () =>
    withUploads({}, async ({ uploads, local }) => {
      const files: Array<[string, Buffer]> = [
        ["a.png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")],
        ["a.jpg", Buffer.from("ffd8ffe000104a464946", "hex")],
        ["a.tif", Buffer.from("49492a0008000000", "hex")],
        ["b.tif", Buffer.from("4d4d002a00000008", "hex")],
        ["a.gif", Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")],
        ["a.webp", Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1")],
        [
          "a.heic",
          Buffer.concat([
            Buffer.from("00000018", "hex"),
            Buffer.from("ftypheic"),
          ]),
        ],
      ];
      for (const [name, file] of files) {
        const link = uploads.request({});
        const res = await fetch(local(link.url), form(file, name));
        assert.equal(res.status, 200, name);
      }
    }));
});

describe("uploadConfig", () => {
  const both = {
    PAPERLESS_UPLOAD_API_KEY: "upload-token",
    PAPERLESS_UPLOAD_PUBLIC_URL: "https://u",
  };

  test("gives the upload token and URL in HTTP mode", () => {
    assert.deepEqual(uploadConfig(both, true), {
      token: "upload-token",
      publicUrl: "https://u",
    });
  });

  test("gives nothing when neither value is set", () => {
    assert.equal(uploadConfig({}, true), undefined);
  });

  test("gives nothing in stdio mode, which has no HTTP route", () => {
    assert.equal(uploadConfig(both, false), undefined);
  });

  test("refuses only one of the two values", () => {
    assert.throws(
      () => uploadConfig({ PAPERLESS_UPLOAD_API_KEY: "x" }, true),
      /both/
    );
    assert.throws(
      () => uploadConfig({ PAPERLESS_UPLOAD_PUBLIC_URL: "x" }, true),
      /both/
    );
  });
});
