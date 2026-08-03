const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP",
  "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR", "CODEX_HOME"
]);

const DENIED_KEY = /(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|COOKIE|DATABASE_URL|REDIS_URL|AWS_|AZURE_|GOOGLE_|GITHUB_|OPENAI_|ANTHROPIC_|GEMINI_|DEEPSEEK_|OAUTH|PRIVATE_KEY)/i;

export function buildSafeEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || DENIED_KEY.test(key) || !ALLOWED_ENVIRONMENT_KEYS.has(key.toUpperCase())) continue;
    environment[key] = value;
  }
  environment.NO_COLOR = "1";
  return environment;
}

export function safeEnvironmentKeyNames(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).sort((left, right) => left.localeCompare(right));
}

export function isEnvironmentKeyAllowed(key: string): boolean {
  return !DENIED_KEY.test(key) && ALLOWED_ENVIRONMENT_KEYS.has(key.toUpperCase());
}
