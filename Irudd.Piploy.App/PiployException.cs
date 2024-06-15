namespace Irudd.Piploy.App;

public class PiployException(string? message, string code) : Exception(message)
{
    public const string PortAlreadyInUseCode = "portAlreadyInUse";

    public static PiployException CreatePortAlreadyInUse(IEnumerable<int>? hostPorts) =>
        new PiployException($"At least one of these ports are already in use by the host: {string.Join(", ", hostPorts ?? Enumerable.Empty<int>())}", PortAlreadyInUseCode);

    public string Code => code;
}
