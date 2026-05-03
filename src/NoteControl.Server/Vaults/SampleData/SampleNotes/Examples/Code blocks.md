---
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
tags: [reference, code]
locked: false
---
# Code blocks

NoteControl supports syntax highlighting for ~30 common languages out of the box, plus IEC 61131-3 **Structured Text** (the language used in TwinCAT 3 and most other PLC environments). ST is the default for new code blocks.

## Structured Text

A simple state machine, with comments in Danish:

```st
// Tilstandsmaskine for AX5000-styring
VAR
    state    : INT := 0;
    enable   : BOOL;
    fault    : BOOL;
END_VAR

CASE state OF
    0:  // Idle — venter på enable-signal
        IF enable AND NOT fault THEN
            state := 10;
        END_IF;

    10: // Powerup
        AX5000.bExecute := TRUE;
        IF AX5000.bDone THEN
            state := 20;
        ELSIF AX5000.bError THEN
            state := 99;
        END_IF;

    20: // Drift
        IF NOT enable OR fault THEN
            state := 30;
        END_IF;

    30: // Powerdown
        AX5000.bExecute := FALSE;
        IF AX5000.bDone THEN
            state := 0;
        END_IF;

    99: // Fejltilstand — kræver reset
        IF reset THEN
            state := 0;
        END_IF;
END_CASE;
```

## TypeScript

```ts
type Vault = {
  id: string;
  path: string;
  scope: 'personal' | 'shared';
};

async function listVaults(client: ApiClient): Promise<Vault[]> {
  const resp = await client.get('/api/vaults');
  return resp.data as Vault[];
}
```

## Python

```python
def fibonacci(n: int) -> list[int]:
    """Return the first n Fibonacci numbers."""
    a, b = 0, 1
    out = []
    for _ in range(n):
        out.append(a)
        a, b = b, a + b
    return out


print(fibonacci(10))
# [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
```

## C#

```csharp
public sealed record Vault(
    Guid Id,
    string Path,
    string Scope);

public interface IVaultService
{
    Task<IReadOnlyList<Vault>> ListAsync(CancellationToken ct = default);
}
```

## Bash / PowerShell

```powershell
# Quick health probe of the running NoteControl server.
Invoke-WebRequest -Uri "http://localhost:8080/health" -UseBasicParsing |
    Select-Object -ExpandProperty StatusCode
```

<div class="nc-callout nc-callout-tip" data-variant="tip">

**Add languages.** If you regularly work in a language not in highlight.js's default set, file an issue — registering new grammars takes a few lines (Structured Text was added the same way).

</div>
