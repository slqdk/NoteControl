---
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
tags: [reference, images]
locked: false
---
# Images and links

## Pasting images

The fastest way to get an image into a note: take a screenshot (Win+Shift+S on Windows), then **Ctrl+V** in the editor. NoteControl saves the image next to the note in a sibling folder named after the note plus `.assets`, and inserts a markdown link with the right path.

For example, this note's images would land in:

```
{vault}/Examples/Images and links.assets/paste-20260503-093045.png
```

…and the markdown reference would look like:

```
![paste-20260503-093045.png](Images%20and%20links.assets/paste-20260503-093045.png)
```

Spaces get URL-encoded (`%20`) so the path is safe to use as a link target.

## Inserting from a file

Use `/image` from the slash menu, then pick a `.png`, `.jpg`, `.gif`, or `.webp`. Same destination folder, same naming convention.

## Resizing and aligning

Click an image to select it, then drag the right edge to resize. The size is saved as inline HTML attributes in the markdown (`width="600"`), so it round-trips correctly to other markdown viewers — though they may ignore the size and just show the natural-size image.

## Renaming a note

If you rename a note that has attached images, the `.assets/` folder is renamed alongside it AND the image references inside the markdown are rewritten. So renaming **just works** — no broken images afterwards.

<div class="nc-callout nc-callout-info" data-variant="info">

**Behind the scenes.** When you rename `Foo.md` → `Bar.md`, the server moves the file, renames `Foo.assets/` → `Bar.assets/`, and rewrites every `Foo.assets/...` reference inside the body to `Bar.assets/...`. All atomic with the rename.

</div>

## Linking to other notes

Use markdown link syntax with a relative path. For example:

- [Welcome — Start here](../Welcome/Start%20here.md)
- [Slash menu reference](../Welcome/Slash%20menu%20reference.md)
- [Code blocks](Code%20blocks.md)

Spaces in folder/file names need to be URL-encoded as `%20`.

## External links

External URLs work like regular markdown:

- [Official spec — IEC 61131-3](https://en.wikipedia.org/wiki/IEC_61131-3)
- [CodeSys documentation](https://content.helpme-codesys.com/)
- [.NET API reference](https://learn.microsoft.com/dotnet/api/)

External links open in a new browser tab.

## Videos and other files

The `/video` slash command pastes a video tag for `.mp4`, `.webm`, or `.mov` files — same `.assets/` storage as images.

For other binary attachments (PDFs, Excel sheets, ST source archives), drop them into the `.assets/` folder manually and link to them with regular markdown link syntax. The browser will offer to download them when clicked.
