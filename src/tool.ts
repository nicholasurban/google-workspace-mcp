import { z } from "zod";
import { WorkspaceAPI, handleApiError } from "./api.js";

import { handleGmail } from "./modes/gmail.js";
import { handleCalendar } from "./modes/calendar.js";
import { handleDrive } from "./modes/drive.js";
import { handleContacts } from "./modes/contacts.js";

export const TOOL_NAME = "google_workspace";

export const TOOL_DESCRIPTION = `Manage Google Workspace across 3 Outliyr accounts. 4 modes:
- gmail: search/read/send/reply emails, manage labels
- calendar: list/create/update/delete events, list calendars
- drive: search/list/read/download/upload/share files and folders
- contacts: search/list/get/create/update contacts`;

export const TOOL_SCHEMA = {
  account: z
    .enum(["nick@outliyr.com", "outliyraffiliates@gmail.com", "iamnickurban@gmail.com"])
    .describe("Which Google account to act as"),

  mode: z
    .enum(["gmail", "calendar", "drive", "contacts"])
    .describe("Service to use"),

  action: z
    .string()
    .describe(
      "Sub-action. " +
        "gmail: search/read/read_thread/send/reply/labels_list/labels_modify. " +
        "calendar: list_events/get_event/create_event/update_event/delete_event/list_calendars. " +
        "drive: search/list/get/download/upload/create_folder/move/share. " +
        "contacts: search/list/get/create/update",
    ),

  // Gmail fields
  query: z.string().optional().describe("Search query (Gmail search syntax or Drive query syntax)"),
  message_id: z.string().optional().describe("Gmail message ID"),
  thread_id: z.string().optional().describe("Gmail thread ID"),
  attachment_id: z.string().optional().describe("Gmail attachment ID to download"),
  format: z
    .enum(["minimal", "metadata", "full"])
    .default("metadata")
    .optional()
    .describe("Gmail message format"),
  to: z.array(z.string()).optional().describe("Recipient email addresses"),
  cc: z.array(z.string()).optional().describe("CC addresses"),
  bcc: z.array(z.string()).optional().describe("BCC addresses"),
  subject: z.string().optional().describe("Email subject or event summary"),
  body: z.string().optional().describe("Email body (plain text or HTML) or event description"),
  html: z.boolean().default(false).optional().describe("If true, email body is HTML"),
  in_reply_to: z.string().optional().describe("Message ID to reply to"),
  label_ids_add: z.array(z.string()).optional().describe("Label IDs to add"),
  label_ids_remove: z.array(z.string()).optional().describe("Label IDs to remove"),

  // Calendar fields
  event_id: z.string().optional().describe("Calendar event ID"),
  calendar_id: z.string().default("primary").optional().describe("Calendar ID (default: primary)"),
  start: z.string().optional().describe("Event start (ISO 8601 datetime or YYYY-MM-DD for all-day)"),
  end: z.string().optional().describe("Event end (ISO 8601 datetime or YYYY-MM-DD for all-day)"),
  location: z.string().optional().describe("Event location"),
  attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
  time_min: z.string().optional().describe("List events after this time (ISO 8601)"),
  time_max: z.string().optional().describe("List events before this time (ISO 8601)"),

  // Drive fields
  file_id: z.string().optional().describe("Drive file or folder ID"),
  parent_id: z.string().optional().describe("Parent folder ID"),
  file_name: z.string().optional().describe("File or folder name"),
  mime_type: z.string().optional().describe("MIME type for upload or export"),
  content: z.string().optional().describe("Text content for file upload"),
  share_email: z.string().optional().describe("Email to share file with"),
  share_role: z.enum(["reader", "commenter", "writer"]).default("reader").optional().describe("Share permission role"),

  // Contacts fields
  resource_name: z.string().optional().describe("Contact resource name (people/...)"),
  given_name: z.string().optional().describe("Contact first name"),
  family_name: z.string().optional().describe("Contact last name"),
  email: z.string().optional().describe("Contact email"),
  phone: z.string().optional().describe("Contact phone number"),
  organization: z.string().optional().describe("Contact organization/company"),

  // Common
  max_results: z.number().int().min(1).max(100).default(10).optional().describe("Max results to return"),
};

export type ToolParams = z.infer<z.ZodObject<typeof TOOL_SCHEMA>>;

export async function toolHandler(api: WorkspaceAPI, params: ToolParams): Promise<string> {
  try {
    switch (params.mode) {
      case "gmail":
        return await handleGmail(api, params);
      case "calendar":
        return await handleCalendar(api, params);
      case "drive":
        return await handleDrive(api, params);
      case "contacts":
        return await handleContacts(api, params);
      default:
        return JSON.stringify({ error: `Unknown mode: ${(params as Record<string, unknown>).mode}` });
    }
  } catch (err) {
    return JSON.stringify({ error: handleApiError(err) });
  }
}
