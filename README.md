# inline-images

A Claude Code mod that draws images inline in the chat transcript, in terminals
that speak the kitty graphics protocol (Ghostty, kitty).

- **Images Claude reads**: a `Read` of a PNG, JPEG, GIF or WebP shows the picture
  under the tool row, also inside a folded "Read N files" line.
- **Images tools return**: browser screenshots (Claude in Chrome), computer use,
  design tools and any other MCP tool that returns an image block.
- **Images you paste**: drawn under your message.

Pictures are sized to at most 60 columns by 24 rows, keeping their aspect ratio.
In other terminals and on the desktop, VS Code and mobile surfaces the mod does
nothing and the transcript draws as usual.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install inline-images --marketplace MarkDannemiller/claude-inline-images
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

From a shell:

```
claude plugin install inline-images --marketplace MarkDannemiller/claude-inline-images
```

## Requirements and limits

- macOS: images are converted to PNG with the built-in `base64` and `sips`
  tools, into `/tmp/claude-inline-images/`. Images larger than 1600 px are
  shrunk; smaller ones are left as they are.
- A terminal with the kitty graphics protocol and local file transfer
  (Ghostty, kitty). tmux does not pass the protocol through.
- Pasted images show for prompts sent while the mod is loaded; tool and `Read`
  images also show in resumed sessions.
- PDF pages read by Claude are not drawn: the transcript does not keep them.

## License

MIT
