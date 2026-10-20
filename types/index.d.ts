/** One picture converted to a PNG on disk, with its pixel size. */
export type Picture = { file: string; width: number; height: number }

declare module 'claude-code' {
  interface PluginState {
    'inline-images': {
      /** By tool_use_id for a tool result, by row uuid for a prompt. */
      pictures: Record<string, Picture[]>
    }
  }
}
