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

const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSignedToken(secret: string): string {
  const issuedAt = Date.now().toString();
  const payload = Buffer.from(issuedAt).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySignedToken(token: string, secret: string): boolean {
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const issuedAt = parseInt(Buffer.from(payload, "base64url").toString(), 10);
  if (isNaN(issuedAt)) return false;
  return Date.now() - issuedAt < TOKEN_MAX_AGE_MS;
}

export function setupOAuth(app: any, config: OAuthConfig) {
  const authCodes = new Map<string, StoredCode>();

  setInterval(() => {
    const now = Date.now();
    for (const [code, stored] of authCodes) {
      if (stored.expiresAt < now) authCodes.delete(code);
    }
  }, 60_000);

  app.get("/.well-known/oauth-protected-resource", (_req: any, res: any) => {
    res.json({
      resource: `${config.publicUrl}/mcp`,
      authorization_servers: [config.publicUrl],
      bearer_methods_supported: ["header"],
    });
  });

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

    const accessToken = createSignedToken(config.clientSecret);

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(TOKEN_MAX_AGE_MS / 1000),
    });
  });

  return {
    validateToken(req: any): boolean {
      const auth = req.headers.authorization;
      if (!auth) return false;
      const token = auth.replace(/^Bearer\s+/i, "");
      if (config.staticToken && token === config.staticToken) return true;
      return verifySignedToken(token, config.clientSecret);
    },
  };
}
