---
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
tags: [reference, code]
locked: false
---
# Code blocks

NoteControl supports syntax highlighting for ~30 common languages out of the box, plus IEC 61131-3 **Structured Text** (the language used in CodeSys, Siemens TIA Portal SCL, and most other PLC environments). ST is the default for new code blocks.

## Structured Text

A simple state machine in CodeSys, with comments in Danish:

```st
// Tilstandsmaskine for konveyor-styring
VAR
    state    : INT := 0;
    enable   : BOOL;
    fault    : BOOL;
    reset    : BOOL;
    motor    : Motor_FB;
END_VAR

CASE state OF
    0:  // Idle — venter på enable-signal
        IF enable AND NOT fault THEN
            state := 10;
        END_IF;

    10: // Powerup
        motor.bExecute := TRUE;
        IF motor.bDone THEN
            state := 20;
        ELSIF motor.bError THEN
            state := 99;
        END_IF;

    20: // Drift
        IF NOT enable OR fault THEN
            state := 30;
        END_IF;

    30: // Powerdown
        motor.bExecute := FALSE;
        IF motor.bDone THEN
            state := 0;
        END_IF;

    99: // Fejltilstand — kræver reset
        IF reset THEN
            state := 0;
        END_IF;
END_CASE;
```

A function block with VAR_INPUT / VAR_OUTPUT for re-use:

```st
FUNCTION_BLOCK Ramp
VAR_INPUT
    target   : REAL;
    rate     : REAL;          // units per cycle
    enable   : BOOL;
END_VAR
VAR_OUTPUT
    current  : REAL;
    done     : BOOL;
END_VAR

IF NOT enable THEN
    current := 0.0;
    done := FALSE;
    RETURN;
END_IF;

IF current < target THEN
    current := MIN(current + rate, target);
ELSIF current > target THEN
    current := MAX(current - rate, target);
END_IF;

done := (current = target);
```

## C#

```csharp
using System.Text.Json;

public sealed record Vault(
    Guid Id,
    string Path,
    string Scope,
    DateTimeOffset CreatedAt);

public interface IVaultService
{
    Task<IReadOnlyList<Vault>> ListAsync(CancellationToken ct = default);
    Task<Vault?> GetAsync(Guid id, CancellationToken ct = default);
}

public sealed class VaultService(HttpClient http) : IVaultService
{
    public async Task<IReadOnlyList<Vault>> ListAsync(CancellationToken ct = default)
    {
        // Pattern matching + null-coalescing-throw is a clean way
        // to fail fast when the API changes shape underneath us.
        var resp = await http.GetAsync("/api/vaults", ct);
        resp.EnsureSuccessStatusCode();
        var stream = await resp.Content.ReadAsStreamAsync(ct);
        return await JsonSerializer.DeserializeAsync<List<Vault>>(
                   stream, JsonDefaults.Options, ct)
               ?? throw new InvalidOperationException("Empty vault list payload.");
    }

    public async Task<Vault?> GetAsync(Guid id, CancellationToken ct = default) =>
        await http.GetFromJsonAsync<Vault>($"/api/vaults/{id}", ct);
}
```

A LINQ + record example, useful when you want to group and project:

```csharp
record Trade(string Symbol, decimal Price, int Quantity, DateTimeOffset At);

var dayTotals = trades
    .GroupBy(t => t.At.Date)
    .Select(g => new
    {
        Day      = g.Key,
        Volume   = g.Sum(t => t.Quantity),
        VWAP     = g.Sum(t => t.Price * t.Quantity) / g.Sum(t => t.Quantity),
    })
    .OrderBy(x => x.Day);

foreach (var d in dayTotals)
{
    Console.WriteLine($"{d.Day:yyyy-MM-dd}  vol={d.Volume,8}  vwap={d.VWAP:F4}");
}
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

## Bash / PowerShell

```powershell
# Quick health probe of the running NoteControl server.
Invoke-WebRequest -Uri "http://localhost:8080/health" -UseBasicParsing |
    Select-Object -ExpandProperty StatusCode
```

<div class="nc-callout nc-callout-tip" data-variant="tip">

**Add languages.** If you regularly work in a language not in highlight.js's default set, file an issue — registering new grammars takes a few lines (Structured Text was added the same way).

</div>
