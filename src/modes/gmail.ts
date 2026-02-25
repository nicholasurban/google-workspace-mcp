import { WorkspaceAPI } from "../api.js";
import type { ToolParams } from "../tool.js";

const MAX_BODY_LENGTH = 50_000;

function decodeBody(payload: any): string {
  // Try to find text/plain first, then text/html
  if (payload.parts) {
    const textPart = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }
    const htmlPart = payload.parts.find((p: any) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
      return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = decodeBody(part);
        if (nested) return nested;
      }
    }
  }
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  return "";
}

function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function formatMessage(msg: any, includeBody: boolean): Record<string, unknown> {
  const headers = msg.payload?.headers || [];
  const result: Record<string, unknown> = {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: msg.snippet,
    labelIds: msg.labelIds,
  };
  if (includeBody && msg.payload) {
    let body = decodeBody(msg.payload);
    if (body.length > MAX_BODY_LENGTH) {
      body = body.slice(0, MAX_BODY_LENGTH) + "\n\n[Truncated — body exceeded 50KB]";
    }
    result.body = body;

    // List attachments
    const attachments = (msg.payload.parts || [])
      .filter((p: any) => p.filename && p.body?.attachmentId)
      .map((p: any) => ({
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.body.size,
        attachmentId: p.body.attachmentId,
      }));
    if (attachments.length > 0) result.attachments = attachments;
  }
  return result;
}

function buildRawEmail(params: ToolParams, inReplyHeaders?: { messageId: string; subject: string; threadId: string }): string {
  const lines: string[] = [];
  const to = params.to?.join(", ") || "";
  const cc = params.cc?.join(", ");
  const bcc = params.bcc?.join(", ");

  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);

  if (inReplyHeaders) {
    const subject = params.subject || (inReplyHeaders.subject.startsWith("Re:") ? inReplyHeaders.subject : `Re: ${inReplyHeaders.subject}`);
    lines.push(`Subject: ${subject}`);
    lines.push(`In-Reply-To: ${inReplyHeaders.messageId}`);
    lines.push(`References: ${inReplyHeaders.messageId}`);
  } else {
    lines.push(`Subject: ${params.subject || ""}`);
  }

  if (params.html) {
    lines.push("Content-Type: text/html; charset=utf-8");
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8");
  }

  lines.push("");
  lines.push(params.body || "");

  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export async function handleGmail(api: WorkspaceAPI, params: ToolParams): Promise<string> {
  const gmail = api.gmail(params.account);
  const action = params.action || "search";

  switch (action) {
    case "search": {
      if (!params.query) return JSON.stringify({ error: "query is required for search" });
      const res = await gmail.users.messages.list({
        userId: "me",
        q: params.query,
        maxResults: params.max_results || 10,
      });
      const messages = res.data.messages || [];
      if (messages.length === 0) return JSON.stringify({ results: [], total: 0 });

      const detailed = await Promise.all(
        messages.map(async (m) => {
          const msg = await gmail.users.messages.get({
            userId: "me",
            id: m.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });
          return formatMessage(msg.data, false);
        }),
      );
      return JSON.stringify({ results: detailed, total: res.data.resultSizeEstimate });
    }

    case "read": {
      if (!params.message_id) return JSON.stringify({ error: "message_id is required for read" });
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: params.message_id,
        format: params.format || "full",
      });
      return JSON.stringify(formatMessage(msg.data, true));
    }

    case "read_thread": {
      if (!params.thread_id) return JSON.stringify({ error: "thread_id is required for read_thread" });
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: params.thread_id,
        format: params.format || "full",
      });
      const messages = (thread.data.messages || []).map((m) => formatMessage(m, true));
      return JSON.stringify({ threadId: thread.data.id, messages });
    }

    case "attachments": {
      if (!params.message_id || !params.attachment_id) {
        return JSON.stringify({ error: "message_id and attachment_id are required" });
      }
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: params.message_id,
        id: params.attachment_id,
      });
      return JSON.stringify({ size: att.data.size, data: att.data.data });
    }

    case "send": {
      if (!params.to || !params.subject) {
        return JSON.stringify({ error: "to and subject are required for send" });
      }
      const raw = buildRawEmail(params);
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      return JSON.stringify({ sent: true, id: res.data.id, from: params.account });
    }

    case "reply": {
      if (!params.in_reply_to || !params.body) {
        return JSON.stringify({ error: "in_reply_to and body are required for reply" });
      }
      // Fetch original message to get headers
      const original = await gmail.users.messages.get({
        userId: "me",
        id: params.in_reply_to,
        format: "metadata",
        metadataHeaders: ["Message-ID", "Subject", "From", "To"],
      });
      const headers = original.data.payload?.headers || [];
      const messageId = getHeader(headers, "Message-ID");
      const originalSubject = getHeader(headers, "Subject");
      const originalFrom = getHeader(headers, "From");

      // Default reply-to is the original sender
      const replyTo = params.to || [originalFrom];
      const replyParams = { ...params, to: replyTo };

      const raw = buildRawEmail(replyParams, {
        messageId,
        subject: originalSubject,
        threadId: original.data.threadId || "",
      });
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, threadId: original.data.threadId || undefined },
      });
      return JSON.stringify({ sent: true, id: res.data.id, threadId: original.data.threadId, from: params.account });
    }

    case "labels_list": {
      const res = await gmail.users.labels.list({ userId: "me" });
      const labels = (res.data.labels || []).map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
      }));
      return JSON.stringify({ labels });
    }

    case "labels_modify": {
      if (!params.message_id) return JSON.stringify({ error: "message_id is required for labels_modify" });
      const res = await gmail.users.messages.modify({
        userId: "me",
        id: params.message_id,
        requestBody: {
          addLabelIds: params.label_ids_add || [],
          removeLabelIds: params.label_ids_remove || [],
        },
      });
      return JSON.stringify({ id: res.data.id, labelIds: res.data.labelIds });
    }

    default:
      return JSON.stringify({ error: `Unknown gmail action: ${action}` });
  }
}
