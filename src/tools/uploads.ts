import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { Uploads } from "../uploads";
import { withErrorHandling } from "./utils/middlewares";

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

// The upload goes in as the upload user, so nothing else examines the token of
// the caller: this check refuses a token that Paperless does not know. Any caller that sets
// tags can view them; the UI settings need a permission of their own.
async function checkCaller(api: PaperlessAPI) {
  await api.request("/tags/?page_size=1");
}

export function registerUploadTools(
  server: McpServer,
  api: PaperlessAPI,
  uploads: Uploads
) {
  server.tool(
    "request_upload",
    "Make a single-use link for the upload of one file (PDF or image) to Paperless. Use it instead of post_document: the file does not go through the conversation. " +
      "With a shell, run the curl command of the result. Otherwise give the link to the user, who opens it and selects the file. " +
      "The link works one time and expires after 15 minutes. Each upload gets the tag via-mcp. Then call check_upload with the upload_id.",
    {
      title: z.string().optional().describe("Title of the new document"),
      tags: z.array(z.number()).optional().describe("Tag IDs to set"),
      correspondent: z.number().optional().describe("Correspondent ID to set"),
      document_type: z.number().optional().describe("Document type ID to set"),
    },
    withErrorHandling(async (args) => {
      await checkCaller(api);
      const link = uploads.request(args);
      return jsonResult({ ...link, curl: `curl -F file=@<path> ${link.url}` });
    })
  );

  server.tool(
    "check_upload",
    "Tell the status of an upload of request_upload. The status is pending (no file yet), receiving (the file arrives now), expired, failed (with the error), submitted (Paperless has no task yet), unknown (no such upload_id), or the status of the Paperless task. When the task status is SUCCESS, document_id is the new document.",
    {
      upload_id: z.string().describe("The upload_id from request_upload"),
    },
    withErrorHandling(async (args) => {
      await checkCaller(api);
      return jsonResult(await uploads.status(args.upload_id));
    })
  );
}
