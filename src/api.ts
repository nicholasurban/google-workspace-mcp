import { google, gmail_v1, calendar_v3, drive_v3 } from "googleapis";
import { JWT, OAuth2Client } from "google-auth-library";
import type { people_v1 } from "googleapis";
import fs from "node:fs";

const ALLOWED_ACCOUNTS = [
  "nick@outliyr.com",
  "outliyraffiliates@gmail.com",
  "iamnickurban@gmail.com",
] as const;

export type AllowedAccount = (typeof ALLOWED_ACCOUNTS)[number];

export function isAllowedAccount(account: string): account is AllowedAccount {
  return (ALLOWED_ACCOUNTS as readonly string[]).includes(account);
}

const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/contacts",
];

// Workspace account uses service account + domain-wide delegation
// Gmail accounts use OAuth2 refresh tokens
const WORKSPACE_ACCOUNT = "nick@outliyr.com";

export { SCOPES };

export interface TokenConfig {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export class WorkspaceAPI {
  private keyFile: string;
  private tokensFile: string;
  private tokens: Record<string, TokenConfig> = {};
  private authClients = new Map<string, JWT | OAuth2Client>();
  private gmailClients = new Map<string, gmail_v1.Gmail>();
  private calendarClients = new Map<string, calendar_v3.Calendar>();
  private driveClients = new Map<string, drive_v3.Drive>();
  private peopleClients = new Map<string, people_v1.People>();

  constructor(keyFile: string, tokensFile: string) {
    this.keyFile = keyFile;
    this.tokensFile = tokensFile;
    this.loadTokens();
  }

  get tokensFilePath(): string {
    return this.tokensFile;
  }

  loadTokens(): void {
    try {
      const raw = fs.readFileSync(this.tokensFile, "utf-8");
      this.tokens = JSON.parse(raw);
      // Clear cached clients so they pick up new tokens
      this.authClients.clear();
      this.gmailClients.clear();
      this.calendarClients.clear();
      this.driveClients.clear();
      this.peopleClients.clear();
    } catch {
      // Tokens file doesn't exist yet — Gmail accounts won't work until generated
      this.tokens = {};
    }
  }

  saveToken(email: string, token: TokenConfig): void {
    this.tokens[email] = token;
    const dir = this.tokensFile.substring(0, this.tokensFile.lastIndexOf("/"));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.tokensFile, JSON.stringify(this.tokens, null, 2));
    // Clear cached clients so they pick up new tokens
    this.authClients.delete(email);
    this.gmailClients.delete(email);
    this.calendarClients.delete(email);
    this.driveClients.delete(email);
    this.peopleClients.delete(email);
  }

  getConfiguredAccounts(): string[] {
    const accounts: string[] = [WORKSPACE_ACCOUNT];
    for (const email of Object.keys(this.tokens)) {
      if (!accounts.includes(email)) accounts.push(email);
    }
    return accounts;
  }

  private auth(account: string): JWT | OAuth2Client {
    if (!isAllowedAccount(account)) {
      throw new Error(`Account not allowed: ${account}`);
    }

    let client = this.authClients.get(account);
    if (client) return client;

    if (account === WORKSPACE_ACCOUNT) {
      // Service account with domain-wide delegation
      client = new JWT({
        keyFile: this.keyFile,
        scopes: SCOPES,
        subject: account,
      });
    } else {
      // OAuth2 with stored refresh token
      const tokenConfig = this.tokens[account];
      if (!tokenConfig) {
        throw new Error(
          `No refresh token for ${account}. Run the token generation script: npm run generate-token`,
        );
      }
      const oauth2 = new OAuth2Client(tokenConfig.client_id, tokenConfig.client_secret);
      oauth2.setCredentials({ refresh_token: tokenConfig.refresh_token });
      client = oauth2;
    }

    this.authClients.set(account, client);
    return client;
  }

  gmail(account: string): gmail_v1.Gmail {
    let client = this.gmailClients.get(account);
    if (!client) {
      client = google.gmail({ version: "v1", auth: this.auth(account) });
      this.gmailClients.set(account, client);
    }
    return client;
  }

  calendar(account: string): calendar_v3.Calendar {
    let client = this.calendarClients.get(account);
    if (!client) {
      client = google.calendar({ version: "v3", auth: this.auth(account) });
      this.calendarClients.set(account, client);
    }
    return client;
  }

  drive(account: string): drive_v3.Drive {
    let client = this.driveClients.get(account);
    if (!client) {
      client = google.drive({ version: "v3", auth: this.auth(account) });
      this.driveClients.set(account, client);
    }
    return client;
  }

  people(account: string): people_v1.People {
    let client = this.peopleClients.get(account);
    if (!client) {
      client = google.people({ version: "v1", auth: this.auth(account) });
      this.peopleClients.set(account, client);
    }
    return client;
  }
}

export function handleApiError(error: unknown): string {
  if (error && typeof error === "object" && "response" in error) {
    const resp = (error as any).response;
    const status = resp?.status;
    const data = resp?.data;
    const msg =
      data?.error?.message ||
      (typeof data === "string" ? data : JSON.stringify(data));

    switch (status) {
      case 400:
        return `Bad request: ${msg}`;
      case 401:
        return `Auth failed — check credentials. For nick@outliyr.com: verify domain-wide delegation. For Gmail accounts: refresh token may be revoked, re-run generate-token. ${msg}`;
      case 403:
        return `Forbidden — ensure the required API scope is granted. ${msg}`;
      case 404:
        return `Not found: ${msg}`;
      case 429:
        return "Rate limited. Wait and try again.";
      default:
        return `Google API error ${status}: ${msg}`;
    }
  }
  if (error instanceof Error) {
    if (error.message.includes("invalid_grant")) {
      return "Refresh token revoked or expired. Re-run: npm run generate-token";
    }
    if (error.message.includes("No refresh token")) {
      return `${error.message}. Visit /setup on the server to authorize.`;
    }
    return `Error: ${error.message}`;
  }
  return `Unexpected error: ${String(error)}`;
}
