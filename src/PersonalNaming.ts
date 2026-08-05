export const DEFAULT_USER_DISPLAY_NAME = "You";
export const DEFAULT_BRAIN_DISPLAY_NAME = "Brain";
export const MAX_DISPLAY_NAME_LENGTH = 32;

export interface PersonalNamingSettings {
  userDisplayName: string;
  brainDisplayName: string;
  hasCompletedNamingOnboarding: boolean;
}

export type DisplayNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateDisplayName(
  value: string,
  label: string
): DisplayNameValidation {
  const trimmed = value.trim();

  if (trimmed === "") {
    return { ok: false, error: `${label} cannot be empty.` };
  }

  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      ok: false,
      error: `${label} must be 32 characters or fewer.`
    };
  }

  if (/[>\r\n\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    return {
      ok: false,
      error: `${label} cannot contain >, line breaks, or control characters.`
    };
  }

  return { ok: true, value: trimmed };
}

export function applyPersonalNames(
  settings: PersonalNamingSettings,
  userName: string,
  brainName: string
): string | null {
  const user = validateDisplayName(userName, "Your name");

  if (!user.ok) {
    return user.error;
  }

  const brain = validateDisplayName(brainName, "Brain name");

  if (!brain.ok) {
    return brain.error;
  }

  settings.userDisplayName = user.value;
  settings.brainDisplayName = brain.value;
  settings.hasCompletedNamingOnboarding = true;
  return null;
}

export function resetPersonalNames(
  settings: PersonalNamingSettings
): void {
  settings.userDisplayName = DEFAULT_USER_DISPLAY_NAME;
  settings.brainDisplayName = DEFAULT_BRAIN_DISPLAY_NAME;
  settings.hasCompletedNamingOnboarding = false;
}

export function resolveDisplayName(
  value: unknown,
  fallback: string
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const result = validateDisplayName(value, "Display name");
  return result.ok ? result.value : fallback;
}

export function getPersonalizedWorkspaceTitle(
  settings: PersonalNamingSettings
): string {
  if (!settings.hasCompletedNamingOnboarding) {
    return "Lain Brain";
  }

  return `${settings.userDisplayName} ${settings.brainDisplayName}`;
}

export class NamingOnboardingSession {
  private dismissed = false;
  private open = false;

  begin(completed: boolean): boolean {
    if (completed || this.dismissed || this.open) {
      return false;
    }

    this.open = true;
    return true;
  }

  finish(): void {
    this.open = false;
    this.dismissed = true;
  }

  skip(): void {
    this.finish();
  }

  reset(): void {
    this.dismissed = false;
    this.open = false;
  }
}
