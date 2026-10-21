import type { PluginHostProps } from "@getpaseo/plugin/client";

/** The host-provided chrome every viewer component needs. */
export type ViewerHost = Pick<PluginHostProps, "theme" | "layout">;

/**
 * Chrome plus the host the surface is bound to. Paseo serves one screen for every
 * connected daemon and switches the host in the screen header, so anything that
 * caches or holds host state keys off `host.id`.
 */
export type ViewerSurface = Pick<PluginHostProps, "theme" | "layout" | "host">;
