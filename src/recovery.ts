export type AuthService = "Codex" | "Linear" | "GitHub";

const loginInstructions: Record<AuthService, string> = {
  Codex: "ChatGPT sign-in is required. Run codex login.",
  Linear:
    "Linear authentication required. Run the Symphony linear-login command.",
  GitHub:
    "GitHub authentication required. Check the configured Git and gh credentials.",
};

export class SharedAuthError extends Error {
  constructor(readonly service: AuthService) {
    super(loginInstructions[service]);
  }
}

export const newSessionLabel = "new-session";
