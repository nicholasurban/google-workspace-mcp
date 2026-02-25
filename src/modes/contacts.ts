import { WorkspaceAPI } from "../api.js";
import type { ToolParams } from "../tool.js";

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,biographies,urls,addresses";

function formatContact(person: any): Record<string, unknown> {
  return {
    resourceName: person.resourceName,
    name: person.names?.[0]
      ? `${person.names[0].givenName || ""} ${person.names[0].familyName || ""}`.trim()
      : undefined,
    givenName: person.names?.[0]?.givenName,
    familyName: person.names?.[0]?.familyName,
    emails: person.emailAddresses?.map((e: any) => e.value),
    phones: person.phoneNumbers?.map((p: any) => p.value),
    organization: person.organizations?.[0]?.name,
    title: person.organizations?.[0]?.title,
    urls: person.urls?.map((u: any) => u.value),
  };
}

export async function handleContacts(api: WorkspaceAPI, params: ToolParams): Promise<string> {
  const people = api.people(params.account);
  const action = params.action || "search";

  switch (action) {
    case "search": {
      if (!params.query) return JSON.stringify({ error: "query is required for search" });
      const res = await people.people.searchContacts({
        query: params.query,
        readMask: PERSON_FIELDS,
        pageSize: params.max_results || 10,
      });
      const contacts = (res.data.results || [])
        .map((r: any) => r.person)
        .filter(Boolean)
        .map(formatContact);
      return JSON.stringify({ contacts, count: contacts.length });
    }

    case "list": {
      const res = await people.people.connections.list({
        resourceName: "people/me",
        personFields: PERSON_FIELDS,
        pageSize: params.max_results || 10,
        sortOrder: "LAST_MODIFIED_DESCENDING",
      });
      const contacts = (res.data.connections || []).map(formatContact);
      return JSON.stringify({ contacts, count: contacts.length, total: res.data.totalPeople });
    }

    case "get": {
      if (!params.resource_name) return JSON.stringify({ error: "resource_name is required for get" });
      const res = await people.people.get({
        resourceName: params.resource_name,
        personFields: PERSON_FIELDS,
      });
      return JSON.stringify(formatContact(res.data));
    }

    case "create": {
      if (!params.given_name && !params.email) {
        return JSON.stringify({ error: "At least given_name or email is required for create" });
      }
      const contactData: any = {};
      if (params.given_name || params.family_name) {
        contactData.names = [{ givenName: params.given_name, familyName: params.family_name }];
      }
      if (params.email) {
        contactData.emailAddresses = [{ value: params.email }];
      }
      if (params.phone) {
        contactData.phoneNumbers = [{ value: params.phone }];
      }
      if (params.organization) {
        contactData.organizations = [{ name: params.organization }];
      }
      const res = await people.people.createContact({
        requestBody: contactData,
        personFields: PERSON_FIELDS,
      });
      return JSON.stringify({ created: true, ...formatContact(res.data), from: params.account });
    }

    case "update": {
      if (!params.resource_name) return JSON.stringify({ error: "resource_name is required for update" });
      // Fetch current contact to get etag
      const current = await people.people.get({
        resourceName: params.resource_name,
        personFields: PERSON_FIELDS,
      });
      const updateData: any = { etag: current.data.etag };
      const updateFields: string[] = [];

      if (params.given_name || params.family_name) {
        updateData.names = [{
          givenName: params.given_name || current.data.names?.[0]?.givenName,
          familyName: params.family_name || current.data.names?.[0]?.familyName,
        }];
        updateFields.push("names");
      }
      if (params.email) {
        updateData.emailAddresses = [{ value: params.email }];
        updateFields.push("emailAddresses");
      }
      if (params.phone) {
        updateData.phoneNumbers = [{ value: params.phone }];
        updateFields.push("phoneNumbers");
      }
      if (params.organization) {
        updateData.organizations = [{ name: params.organization }];
        updateFields.push("organizations");
      }

      if (updateFields.length === 0) {
        return JSON.stringify({ error: "No fields to update" });
      }

      const res = await people.people.updateContact({
        resourceName: params.resource_name,
        updatePersonFields: updateFields.join(","),
        requestBody: updateData,
        personFields: PERSON_FIELDS,
      });
      return JSON.stringify({ updated: true, ...formatContact(res.data), from: params.account });
    }

    default:
      return JSON.stringify({ error: `Unknown contacts action: ${action}` });
  }
}
