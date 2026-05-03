# Tray resources

Place `tray.ico` (multi-resolution: 16x16, 32x32, 48x48, 256x256) here.
The tray loads this icon at startup. If missing, Windows will use a default
icon — no crash, just a less polished look during development.

Suggested tools for creating a multi-resolution .ico:

- https://icoconvert.com/
- ImageMagick: `magick convert icon.png -define icon:auto-resize=256,48,32,16 tray.ico`

Once you add `tray.ico` here, make sure it is included in the csproj as:

```xml
<ItemGroup>
  <Resource Include="Resources\tray.ico" />
</ItemGroup>
```
