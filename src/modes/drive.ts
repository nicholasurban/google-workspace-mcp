import { WorkspaceAPI } from "../api.js";
import type { ToolParams } from "../tool.js";
import { Readable } from "node:stream";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_DOWNLOAD_TEXT = 50_000;

const GOOGLE_DOC_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

function formatFile(file: any): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    parents: file.parents,
    webViewLink: file.webViewLink,
    owners: file.owners?.map((o: any) => o.emailAddress),
    shared: file.shared,
  };
}

export async function handleDrive(api: WorkspaceAPI, params: ToolParams): Promise<string> {
  const drive = api.drive(params.account);
  const action = params.action || "search";

  switch (action) {
    case "search": {
      if (!params.query) return JSON.stringify({ error: "query is required for search" });
      const res = await drive.files.list({
        q: params.query,
        pageSize: params.max_results || 10,
        fields: "files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,owners,shared)",
        orderBy: "modifiedTime desc",
      });
      const files = (res.data.files || []).map(formatFile);
      return JSON.stringify({ files, count: files.length });
    }

    case "list": {
      const parentId = params.parent_id || "root";
      const res = await drive.files.list({
        q: `'${parentId}' in parents and trashed=false`,
        pageSize: params.max_results || 10,
        fields: "files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,owners,shared)",
        orderBy: "folder,name",
      });
      const files = (res.data.files || []).map(formatFile);
      return JSON.stringify({ files, count: files.length, parentId });
    }

    case "get": {
      if (!params.file_id) return JSON.stringify({ error: "file_id is required for get" });
      const res = await drive.files.get({
        fileId: params.file_id,
        fields: "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,owners,shared,description",
      });
      return JSON.stringify(formatFile(res.data));
    }

    case "download": {
      if (!params.file_id) return JSON.stringify({ error: "file_id is required for download" });

      // Get file metadata first
      const meta = await drive.files.get({
        fileId: params.file_id,
        fields: "id,name,mimeType,size",
      });
      const mimeType = meta.data.mimeType || "";

      // Google Docs types need export
      const exportType = GOOGLE_DOC_EXPORT_TYPES[mimeType] || params.mime_type;
      let content: string;

      if (exportType) {
        const res = await drive.files.export({
          fileId: params.file_id,
          mimeType: exportType,
        }, { responseType: "text" });
        content = String(res.data);
      } else {
        const res = await drive.files.get({
          fileId: params.file_id,
          alt: "media",
        }, { responseType: "text" });
        content = String(res.data);
      }

      if (content.length > MAX_DOWNLOAD_TEXT) {
        content = content.slice(0, MAX_DOWNLOAD_TEXT) + "\n\n[Truncated — content exceeded 50KB]";
      }

      return JSON.stringify({ id: params.file_id, name: meta.data.name, content });
    }

    case "upload": {
      if (!params.file_name || !params.content) {
        return JSON.stringify({ error: "file_name and content are required for upload" });
      }
      const contentBuffer = Buffer.from(params.content, "utf-8");
      if (contentBuffer.length > MAX_UPLOAD_SIZE) {
        return JSON.stringify({ error: "Content exceeds 10MB upload limit" });
      }
      const res = await drive.files.create({
        requestBody: {
          name: params.file_name,
          parents: params.parent_id ? [params.parent_id] : undefined,
          mimeType: params.mime_type,
        },
        media: {
          mimeType: params.mime_type || "text/plain",
          body: Readable.from(contentBuffer),
        },
        fields: "id,name,mimeType,webViewLink",
      });
      return JSON.stringify({ uploaded: true, ...formatFile(res.data), from: params.account });
    }

    case "create_folder": {
      if (!params.file_name) return JSON.stringify({ error: "file_name is required for create_folder" });
      const res = await drive.files.create({
        requestBody: {
          name: params.file_name,
          mimeType: "application/vnd.google-apps.folder",
          parents: params.parent_id ? [params.parent_id] : undefined,
        },
        fields: "id,name,mimeType,webViewLink",
      });
      return JSON.stringify({ created: true, ...formatFile(res.data), from: params.account });
    }

    case "move": {
      if (!params.file_id || !params.parent_id) {
        return JSON.stringify({ error: "file_id and parent_id are required for move" });
      }
      // Get current parents
      const file = await drive.files.get({ fileId: params.file_id, fields: "parents" });
      const previousParents = (file.data.parents || []).join(",");
      const res = await drive.files.update({
        fileId: params.file_id,
        addParents: params.parent_id,
        removeParents: previousParents,
        fields: "id,name,parents",
      });
      return JSON.stringify({ moved: true, id: res.data.id, name: res.data.name, newParent: params.parent_id });
    }

    case "share": {
      if (!params.file_id || !params.share_email) {
        return JSON.stringify({ error: "file_id and share_email are required for share" });
      }
      await drive.permissions.create({
        fileId: params.file_id,
        requestBody: {
          type: "user",
          role: params.share_role || "reader",
          emailAddress: params.share_email,
        },
      });
      return JSON.stringify({
        shared: true,
        fileId: params.file_id,
        sharedWith: params.share_email,
        role: params.share_role || "reader",
        from: params.account,
      });
    }

    default:
      return JSON.stringify({ error: `Unknown drive action: ${action}` });
  }
}
