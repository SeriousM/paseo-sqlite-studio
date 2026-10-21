import type { PluginHostProps } from "@getpaseo/plugin/client";

/** The host-provided chrome every viewer component needs. */
export type ViewerHost = Pick<PluginHostProps, "theme" | "layout">;
