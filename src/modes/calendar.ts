import { WorkspaceAPI } from "../api.js";
import type { ToolParams } from "../tool.js";

function isAllDay(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function formatEvent(event: any): Record<string, unknown> {
  return {
    id: event.id,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    status: event.status,
    htmlLink: event.htmlLink,
    attendees: event.attendees?.map((a: any) => ({
      email: a.email,
      responseStatus: a.responseStatus,
    })),
    organizer: event.organizer?.email,
    created: event.created,
    updated: event.updated,
  };
}

export async function handleCalendar(api: WorkspaceAPI, params: ToolParams): Promise<string> {
  const cal = api.calendar(params.account);
  const action = params.action || "list_events";
  const calendarId = params.calendar_id || "primary";

  switch (action) {
    case "list_events": {
      const res = await cal.events.list({
        calendarId,
        timeMin: params.time_min || new Date().toISOString(),
        timeMax: params.time_max,
        maxResults: params.max_results || 10,
        singleEvents: true,
        orderBy: "startTime",
        q: params.query,
      });
      const events = (res.data.items || []).map(formatEvent);
      return JSON.stringify({ events, count: events.length });
    }

    case "get_event": {
      if (!params.event_id) return JSON.stringify({ error: "event_id is required" });
      const res = await cal.events.get({ calendarId, eventId: params.event_id });
      return JSON.stringify(formatEvent(res.data));
    }

    case "create_event": {
      if (!params.subject || !params.start || !params.end) {
        return JSON.stringify({ error: "subject, start, and end are required for create_event" });
      }
      const startAllDay = isAllDay(params.start);
      const endAllDay = isAllDay(params.end);
      const res = await cal.events.insert({
        calendarId,
        requestBody: {
          summary: params.subject,
          description: params.body,
          location: params.location,
          start: startAllDay ? { date: params.start } : { dateTime: params.start },
          end: endAllDay ? { date: params.end } : { dateTime: params.end },
          attendees: params.attendees?.map((email) => ({ email })),
        },
      });
      return JSON.stringify({ created: true, ...formatEvent(res.data), from: params.account });
    }

    case "update_event": {
      if (!params.event_id) return JSON.stringify({ error: "event_id is required for update_event" });
      const patch: Record<string, unknown> = {};
      if (params.subject) patch.summary = params.subject;
      if (params.body) patch.description = params.body;
      if (params.location) patch.location = params.location;
      if (params.start) {
        patch.start = isAllDay(params.start) ? { date: params.start } : { dateTime: params.start };
      }
      if (params.end) {
        patch.end = isAllDay(params.end) ? { date: params.end } : { dateTime: params.end };
      }
      if (params.attendees) {
        patch.attendees = params.attendees.map((email) => ({ email }));
      }
      const res = await cal.events.patch({
        calendarId,
        eventId: params.event_id,
        requestBody: patch,
      });
      return JSON.stringify({ updated: true, ...formatEvent(res.data), from: params.account });
    }

    case "delete_event": {
      if (!params.event_id) return JSON.stringify({ error: "event_id is required for delete_event" });
      await cal.events.delete({ calendarId, eventId: params.event_id });
      return JSON.stringify({ deleted: true, eventId: params.event_id, from: params.account });
    }

    case "list_calendars": {
      const res = await cal.calendarList.list();
      const calendars = (res.data.items || []).map((c) => ({
        id: c.id,
        summary: c.summary,
        description: c.description,
        primary: c.primary,
        accessRole: c.accessRole,
        timeZone: c.timeZone,
      }));
      return JSON.stringify({ calendars });
    }

    default:
      return JSON.stringify({ error: `Unknown calendar action: ${action}` });
  }
}
