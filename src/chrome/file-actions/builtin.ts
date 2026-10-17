import type { Platform } from "../../shortcuts/keys";
import { IMAGE_EXTENSIONS } from "../../sidebar/explorer/file-icons";
import { registerFileAction, type FileAction } from "./registry";
import type { OpenInExternalApp } from "./external-app";

const RASTER_IMAGE_EXTENSIONS = [...IMAGE_EXTENSIONS].filter((e) => e !== "svg");

/** Preview.app: raster images + pdf + formats only Preview handles. svg is
 *  left to the browser. */
export const PREVIEW_EXTENSIONS: readonly string[] = [...RASTER_IMAGE_EXTENSIONS, "pdf", "heic", "tif", "tiff"];
export const BROWSER_EXTENSIONS: readonly string[] = ["html", "htm", "svg", "pdf", ...RASTER_IMAGE_EXTENSIONS];

/** The built-in "open with" actions for `platform`: [preview, browser] on
 *  macOS (the only platform the backend supports), none elsewhere. Pure query. */
export function builtinFileActions(platform: Platform, open: OpenInExternalApp): FileAction[] {
  if (platform !== "mac") return [];
  const via = (target: "preview" | "browser", name: string) => (absPath: string): Promise<void> =>
    open(absPath, target).catch((err) => console.error(`Failed to open in ${name}`, err));
  return [
    { id: "preview", label: "미리보기로 열기", extensions: PREVIEW_EXTENSIONS, run: via("preview", "Preview") },
    { id: "browser", label: "브라우저로 열기", extensions: BROWSER_EXTENSIONS, run: via("browser", "the browser") },
  ];
}

/** Registers `builtinFileActions(...)`. Command (void). */
export function registerBuiltinFileActions(platform: Platform, open: OpenInExternalApp): void {
  for (const a of builtinFileActions(platform, open)) registerFileAction(a);
}
