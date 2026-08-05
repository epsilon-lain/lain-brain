import { normalizePath } from "obsidian";

export const DEFAULT_CANDIDATE_NOTE_FOLDER =
  "Lain Brain/Notes";

export type CandidateNotePathResult =
  | {
      ok: true;
      folderPath: string;
      fileName: string;
      vaultPath: string;
    }
  | {
      ok: false;
      error: "Invalid file name" | "Invalid destination folder";
    };

const INVALID_FILE_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function validateCandidateNotePath(
  rawFileName: string,
  rawFolderPath: string
): CandidateNotePathResult {
  const fileName = rawFileName.trim();
  const folderInput = rawFolderPath.trim();

  if (!isValidFileName(fileName)) {
    return { ok: false, error: "Invalid file name" };
  }

  if (!isValidVaultFolder(folderInput)) {
    return { ok: false, error: "Invalid destination folder" };
  }

  const folderPath = normalizePath(
    folderInput.replace(/\\/g, "/")
  );
  const markdownFileName = fileName.toLowerCase().endsWith(".md")
    ? fileName
    : `${fileName}.md`;
  const vaultPath = normalizePath(
    `${folderPath}/${markdownFileName}`
  );

  return {
    ok: true,
    folderPath,
    fileName: markdownFileName,
    vaultPath
  };
}

export function suggestCandidateFileName(title: string): string {
  const suggestion = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!isValidFileName(suggestion)) {
    return "Candidate Note";
  }

  return suggestion;
}

function isValidFileName(fileName: string): boolean {
  if (
    fileName === "" ||
    fileName === "." ||
    fileName === ".." ||
    fileName.length > 240 ||
    INVALID_FILE_NAME_CHARACTERS.test(fileName) ||
    /[. ]$/.test(fileName) ||
    WINDOWS_RESERVED_NAME.test(fileName)
  ) {
    return false;
  }

  const baseName = fileName.toLowerCase().endsWith(".md")
    ? fileName.slice(0, -3)
    : fileName;

  return (
    baseName !== "" &&
    !/[. ]$/.test(baseName) &&
    !WINDOWS_RESERVED_NAME.test(baseName)
  );
}

function isValidVaultFolder(folderPath: string): boolean {
  if (
    folderPath === "" ||
    folderPath.startsWith("/") ||
    folderPath.startsWith("\\") ||
    /^[a-z]:[\\/]/i.test(folderPath) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(folderPath)
  ) {
    return false;
  }

  const segments = folderPath.replace(/\\/g, "/").split("/");

  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !INVALID_FILE_NAME_CHARACTERS.test(segment) &&
      !/[. ]$/.test(segment) &&
      !WINDOWS_RESERVED_NAME.test(segment)
  );
}
export function validateExistingVaultMarkdownPath(
  rawPath: string
): string | null {
  if (
    rawPath === "" ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    /^[a-z]:[\\/]/i.test(rawPath) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)
  ) {
    return null;
  }

  const slashPath = rawPath.replace(/\\/g, "/");
  const segments = slashPath.split("/");

  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    ) ||
    !slashPath.toLowerCase().endsWith(".md")
  ) {
    return null;
  }

  const normalized = normalizePath(slashPath);

  return normalized === slashPath ? normalized : null;
}

export function isSafeWikiLinkTarget(target: string): boolean {
  return (
    target !== "" &&
    !/[#^|\[\]\r\n]/.test(target)
  );
}