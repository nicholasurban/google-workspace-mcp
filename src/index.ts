#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkspaceAPI, SCOPES } from "./api.js";
import { TOOL_NAME, TOOL_DESCRIPTION, TOOL_SCHEMA, toolHandler, ToolParams } from "./tool.js";
import { setupOAuth } from "./oauth.js";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

const server = new McpServer({
  name: "google-workspace-mcp",
  version: "1.0.0",
});

async function main(): Promise<void> {
  const keyFile = process.env.GOOGLE_SA_KEY_FILE;
  if (!keyFile) {
    console.error("ERROR: GOOGLE_SA_KEY_FILE environment variable is required");
    process.exit(1);
  }

  const tokensFile = process.env.GOOGLE_TOKENS_FILE || keyFile.replace(/[^/]+$/, "gmail-tokens.json");
  const api = new WorkspaceAPI(keyFile, tokensFile);

  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    TOOL_SCHEMA,
    async (params) => {
      const result = await toolHandler(api, params as ToolParams);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  const PORT = process.env.PORT ? Number(process.env.PORT) : null;

  if (PORT) {
    const express = (await import("express")).default;
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );

    const oauthClientId = process.env.MCP_OAUTH_CLIENT_ID;
    const oauthClientSecret = process.env.MCP_OAUTH_CLIENT_SECRET;
    const publicUrl = process.env.PUBLIC_URL;

    if (!oauthClientId || !oauthClientSecret || !publicUrl) {
      console.error("ERROR: MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET, and PUBLIC_URL are required for HTTP transport");
      process.exit(1);
    }

    // Google OAuth client credentials (for Gmail account token generation)
    const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    const { validateToken } = setupOAuth(app, {
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      publicUrl,
      staticToken: process.env.MCP_AUTH_TOKEN,
    });

    // ── Setup routes for Gmail account token generation ──
    // Protected by a one-time setup token (SETUP_TOKEN env var)
    const setupToken = process.env.SETUP_TOKEN;

    if (googleClientId && googleClientSecret) {
      const redirectUri = `${publicUrl}/oauth2callback`;

      // GET /setup?token=<SETUP_TOKEN>&account=<email>
      // Starts Google OAuth flow for a Gmail account
      app.get("/setup", (req, res) => {
        const token = req.query.token as string;
        if (!setupToken || token !== setupToken) {
          res.status(403).json({ error: "Invalid or missing setup token" });
          return;
        }

        const account = req.query.account as string;
        if (!account) {
          // Show setup page with links for each account
          const accounts = ["outliyraffiliates@gmail.com", "iamnickurban@gmail.com"];
          const configured = api.getConfiguredAccounts();
          const html = `<!DOCTYPE html><html><body>
            <h1>Google Workspace MCP — Account Setup</h1>
            <h2>Configured accounts:</h2>
            <ul>${configured.map((a) => `<li>${a}</li>`).join("")}</ul>
            <h2>Authorize Gmail accounts:</h2>
            <ul>${accounts.map((a) =>
              `<li><a href="/setup?token=${encodeURIComponent(setupToken)}&account=${encodeURIComponent(a)}">${a}</a></li>`
            ).join("")}</ul>
          </body></html>`;
          res.send(html);
          return;
        }

        const oauth2 = new OAuth2Client(googleClientId, googleClientSecret, redirectUri);
        const authUrl = oauth2.generateAuthUrl({
          access_type: "offline",
          scope: SCOPES,
          prompt: "consent",
          login_hint: account,
          state: JSON.stringify({ account, token: setupToken }),
        });
        res.redirect(authUrl);
      });

      // GET /oauth2callback — Google redirects here after consent
      app.get("/oauth2callback", async (req, res) => {
        const error = req.query.error as string;
        if (error) {
          res.status(400).send(`<h1>Authorization failed</h1><p>${error}</p>`);
          return;
        }

        const code = req.query.code as string;
        const stateRaw = req.query.state as string;
        if (!code || !stateRaw) {
          res.status(400).send("<h1>Missing code or state</h1>");
          return;
        }

        let state: { account: string; token: string };
        try {
          state = JSON.parse(stateRaw);
        } catch {
          res.status(400).send("<h1>Invalid state</h1>");
          return;
        }

        if (!setupToken || state.token !== setupToken) {
          res.status(403).send("<h1>Invalid setup token</h1>");
          return;
        }

        try {
          const oauth2 = new OAuth2Client(googleClientId, googleClientSecret, redirectUri);
          const { tokens } = await oauth2.getToken(code);

          if (!tokens.refresh_token) {
            res.status(400).send(
              `<h1>No refresh token received</h1>
               <p>This usually means the app already has access.
               Revoke it at <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>,
               then try again.</p>`
            );
            return;
          }

          // Verify which email was actually authorized
          oauth2.setCredentials(tokens);
          const gmail = google.gmail({ version: "v1", auth: oauth2 });
          const profile = await gmail.users.getProfile({ userId: "me" });
          const email = profile.data.emailAddress!;

          // Save the token
          api.saveToken(email, {
            client_id: googleClientId,
            client_secret: googleClientSecret,
            refresh_token: tokens.refresh_token,
          });

          const configured = api.getConfiguredAccounts();
          res.send(
            `<h1>Success!</h1>
             <p>Token saved for: <strong>${email}</strong></p>
             <h2>All configured accounts:</h2>
             <ul>${configured.map((a) => `<li>${a}</li>`).join("")}</ul>
             <p><a href="/setup?token=${encodeURIComponent(setupToken)}">Back to setup</a></p>`
          );
        } catch (err: any) {
          console.error("OAuth callback error:", err);
          res.status(500).send(`<h1>Token exchange failed</h1><p>${err.message}</p>`);
        }
      });
    }

    // ── MCP endpoint ──
    app.post("/mcp", async (req, res) => {
      if (!validateToken(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    app.listen(PORT, () => {
      console.error(`Google Workspace MCP server running on http://0.0.0.0:${PORT}/mcp`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Google Workspace MCP server running via stdio");
  }
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
