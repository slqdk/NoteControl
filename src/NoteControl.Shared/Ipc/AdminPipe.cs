namespace NoteControl.Shared.Ipc;

/// <summary>
/// Well-known values for the tray ↔ server named-pipe channel. Kept in the
/// shared project so both ends agree on the wire format.
/// </summary>
public static class AdminPipe
{
    /// <summary>
    /// Name of the local named pipe. The full OS path is
    /// <c>\\.\pipe\notecontrol-admin</c>.
    /// </summary>
    public const string PipeName = "notecontrol-admin";

    /// <summary>Protocol version — bump when the contract changes in a breaking way.</summary>
    public const int ProtocolVersion = 1;
}
