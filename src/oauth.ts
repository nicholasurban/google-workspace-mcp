import crypto from "node:crypto";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  staticToken?: string;
}

interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

export function setupOAuth(app: any, config: OAuthConfig) {
  const authCodes = new Map<string, StoredCode>();
  const accessTokens = new Set<string>();

  // Cleanup expired auth codes periodically
  setInterval(() => {
    const now = Date.now();
    for (const [code, stored] of authCodes) {
      if (stored.expiresAt < now) authCodes.delete(code);
    }
  }, 60_000);

  // MCP Protected Resource Metadata
  app.get("/.well-known/oauth-protected-resource", (_req: any, res: any) => {
    res.json({
      resource: `${config.publicUrl}/mcp`,
      authorization_servers: [config.publicUrl],
      bearer_methods_supported: ["header"],
    });
  });

  // OAuth Authorization Server Metadata
  app.get("/.well-known/oauth-authorization-server", (_req: any, res: any) => {
    res.json({
      issuer: config.publicUrl,
      authorization_endpoint: `${config.publicUrl}/authorize`,
      token_endpoint: `${config.publicUrl}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
  });

  // Authorization endpoint — auto-approves for configured client
  app.get("/authorize", (req: any, res: any) => {
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } =
      req.query as Record<string, string>;

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }
    if (client_id !== config.clientId) {
      res.status(403).json({ error: "invalid_client" });
      return;
    }

    const code = crypto.randomBytes(32).toString("hex");
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || "plain",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  // Token endpoint
  app.post("/token", (req: any, res: any) => {
    const { grant_type, code, client_id, client_secret, redirect_uri, code_verifier } = req.body;

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt < Date.now()) {
      authCodes.delete(code);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    if (client_id !== config.clientId || client_secret !== config.clientSecret) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    if (stored.redirectUri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }

    // PKCE verification
    if (stored.codeChallenge) {
      if (stored.codeChallengeMethod === "S256") {
        const hash = crypto.createHash("sha256").update(code_verifier || "").digest("base64url");
        if (hash !== stored.codeChallenge) {
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
      } else if (code_verifier !== stored.codeChallenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    authCodes.delete(code);

    const accessToken = crypto.randomBytes(32).toString("hex");
    accessTokens.add(accessToken);

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
    });
  });

  return {
    validateToken(req: any): boolean {
      const auth = req.headers.authorization;
      if (!auth) return false;
      const token = auth.replace(/^Bearer\s+/i, "");
      if (config.staticToken && token === config.staticToken) return true;
      return accessTokens.has(token);
    },
  };
}
