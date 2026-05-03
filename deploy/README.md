# Deployment

Files in this folder are reference configurations for running NoteControl in
production. They are not consumed by the build; copy or adapt as needed.

## Files

- **Caddyfile** — reverse-proxy config for Caddy. Handles HTTPS termination
  via Let's Encrypt. Set your hostname at the top before use.

## Future additions (build-order steps 20+)

- `install-service.ps1` — registers `NoteControl.Server.exe` as a Windows
  Service under a dedicated low-privilege account.
- `uninstall-service.ps1` — cleanly removes the service.
- `firewall-rules.ps1` — configures Windows Firewall to allow 80/443 only
  from the router's LAN interface.
- WiX or Inno Setup project for the MSI/EXE installer.

## Recommended production layout

```
C:\Program Files\NoteControl\
├── Server\
│   └── NoteControl.Server.exe
├── Tray\
│   └── NoteControl.Tray.exe
└── Caddy\
    ├── caddy.exe
    └── Caddyfile

C:\ProgramData\NoteControl\
├── NotesData\        ← configurable; can be moved to D:\ etc.
├── logs\
└── backups\          ← local backup target
```

Service account: create a dedicated low-privilege Windows account
(`NoteControlSvc`) with write access only to `C:\ProgramData\NoteControl\`
and read access to `C:\Program Files\NoteControl\Server\`.
