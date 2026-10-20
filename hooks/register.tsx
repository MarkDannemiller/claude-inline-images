import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Picture } from '../types'

type $ = Parameters<Hook<'tool.call'>>[0]
type Encoded = { data: string; mediaType: string }

const TMP = '/tmp/claude-inline-images'
const MAX_COLUMNS = 60
const MAX_ROWS = 24
const MAX_PIXELS = 1600

const pictures = atom({ plugin: 'inline-images', key: 'pictures' } as const, {})

// Each picture is converted once per load, whichever hook asks first.
const converted = new Map<string, Promise<Picture | undefined>>()

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// The image shapes a result or a row may hold: the Messages API's, MCP's, and
// the Read tool's own record.
function encodedOf(block: unknown): Encoded | undefined {
  if (!isObject(block)) return undefined
  const source = block.source
  if (block.type === 'image' && isObject(source) && typeof source.data === 'string') {
    return { data: source.data, mediaType: String(source.media_type ?? 'image/png') }
  }
  if (block.type === 'image' && typeof block.data === 'string') {
    return { data: block.data, mediaType: String(block.mimeType ?? 'image/png') }
  }
  const file = block.file
  if (block.type === 'image' && isObject(file) && typeof file.base64 === 'string') {
    return { data: file.base64, mediaType: String(file.type ?? 'image/png') }
  }
  return undefined
}

function imagesIn(value: unknown, depth = 0): Encoded[] {
  if (depth > 4 || !isObject(value)) return []
  const own = encodedOf(value)
  if (own) return [own]
  const children = Array.isArray(value) ? value : [value.content, value.output]
  return children.flatMap(child => imagesIn(child, depth + 1))
}

// Decodes, converts to PNG (the kitty protocol's one format) and shrinks only
// what is larger than MAX_PIXELS; prints the PNG's width and height.
const CONVERT = `
set -e
base64 -D -i "$1" -o "$2"
sips -s format png "$2" --out "$3" >/dev/null
rm -f "$1" "$2"
w=$(sips -g pixelWidth "$3" | awk '/pixelWidth/ {print $2}')
h=$(sips -g pixelHeight "$3" | awk '/pixelHeight/ {print $2}')
if [ "$w" -gt "$4" ] || [ "$h" -gt "$4" ]; then
  sips -Z "$4" "$3" >/dev/null
  w=$(sips -g pixelWidth "$3" | awk '/pixelWidth/ {print $2}')
  h=$(sips -g pixelHeight "$3" | awk '/pixelHeight/ {print $2}')
fi
echo "$w $h"
`

function toPicture($: $, key: string, image: Encoded): Promise<Picture | undefined> {
  let job = converted.get(key)
  if (!job) {
    const base = `${TMP}/${key.replace(/[^A-Za-z0-9_-]/g, '_')}`
    job = (async () => {
      await $.fs.write(`${base}.b64`, image.data)
      const ran = await $.process.run([
        'sh', '-c', CONVERT, 'sh', `${base}.b64`, `${base}.raw`, `${base}.png`, String(MAX_PIXELS),
      ])
      const [width, height] = ran.stdout.trim().split(' ').map(Number)
      if (ran.exitCode !== 0 || !width || !height) return undefined
      return { file: `${base}.png`, width, height }
    })().catch(() => undefined)
    converted.set(key, job)
  }
  return job
}

// The transcript draws a row's blocks under ids made from the row's uuid with
// its last group replaced by the block's index (`...-000000000000`), so a
// prompt's pictures are kept by the first four groups.
function rowKey(id: string): string {
  return `row:${id.split('-').slice(0, 4).join('-')}`
}

async function remember($: $, key: string, images: Encoded[]) {
  const done = await Promise.all(images.map((image, i) => toPicture($, `${key}-${i}`, image)))
  const kept = done.filter((p): p is Picture => p !== undefined)
  if (kept.length > 0) await update($, pictures, all => ({ ...all, [key]: kept }))
}

function sizeOf(picture: Picture, viewportColumns = 80) {
  // A terminal cell is about twice as tall as it is wide.
  let columns = Math.max(4, Math.min(MAX_COLUMNS, viewportColumns - 8))
  let rows = Math.round((columns * picture.height) / picture.width / 2)
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS
    columns = Math.max(1, Math.round((rows * 2 * picture.width) / picture.height))
  }
  return { columns, rows: Math.max(1, rows) }
}

// What a row draws under it: pictures kept for its key, else (a resumed
// session, whose rows were stored before this load) any its output holds.
async function picturesFor($: $, key: string, output: unknown): Promise<Picture[]> {
  const kept = (await read($, pictures))[key]
  if (kept) return kept
  const found = imagesIn(output)
  const done = await Promise.all(found.map((image, i) => toPicture($, `${key}-${i}`, image)))
  return done.filter((p): p is Picture => p !== undefined)
}

export const register: Register = on => {
  // Rows as they are stored: a tool's result by its call, a prompt by its row.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.door === 'prompt' || e.door === 'delivery') {
      const images = imagesIn(e.message.content)
      if (images.length > 0) void remember($, rowKey(e.uuid), images)
    }
    if (e.door === 'tool-result') {
      for (const block of e.message.content) {
        const images = block.type === 'tool_result' ? imagesIn(block.content) : []
        if (images.length > 0) void remember($, String(block.tool_use_id), images)
      }
    }
    return stored
  }).catch(($, e, next) => next(e))

  // A tool call on its own: the engine's result, then its pictures.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored) return next(e)
    const found = await picturesFor($, e.props.tool_use_id, e.props.output)
    if (found.length === 0) return next(e)

    const own = await next(e)
    const { Box, Image } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {own}
        {found.map(picture => (
          <Box paddingLeft={5}>
            <Image source={{ file: picture.file, format: 'png' }} {...sizeOf(picture, e.viewport?.columns)} alt="[image]" />
          </Box>
        ))}
      </Box>
    )
  })

  // Calls folded into a count line ("Read 2 files"): the line, then each picture.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const found = []
    for (const [i, call] of e.props.calls.entries()) {
      if (call.isErrored || call.isRunning) continue
      found.push(...(await picturesFor($, call.tool_use_id ?? `${e.requestId}-${i}`, call.output)))
    }
    if (found.length === 0) return next(e)

    const own = await next(e)
    const { Box, Image } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {own}
        {found.map(picture => (
          <Box paddingLeft={5}>
            <Image source={{ file: picture.file, format: 'png' }} {...sizeOf(picture, e.viewport?.columns)} alt="[image]" />
          </Box>
        ))}
      </Box>
    )
  })

  // A prompt that carried pasted images: the message, then the pictures.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    // Only the row's first block (index 0) draws them, so they show once.
    const isFirstBlock = /-0+$/.test(e.requestId)
    const found = isFirstBlock ? (await read($, pictures))[rowKey(e.requestId)] ?? [] : []
    if (found.length === 0) return next(e)

    const own = await next(e)
    const { Box, Image } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {own}
        {found.map(picture => (
          <Box paddingLeft={2}>
            <Image source={{ file: picture.file, format: 'png' }} {...sizeOf(picture, e.viewport?.columns)} alt="[image]" />
          </Box>
        ))}
      </Box>
    )
  })
}
