using System.Text.RegularExpressions;

namespace Irudd.Piploy.App;

public static partial class DockerfileImagePolicy
{
    public static void Validate(string dockerfilePath)
    {
        var stages = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var stageCount = 0;

        foreach (var instruction in ReadInstructions(File.ReadAllText(dockerfilePath)))
        {
            var parts = Whitespace().Split(instruction, 2);
            if (parts[0].Equals("FROM", StringComparison.OrdinalIgnoreCase))
            {
                if (parts.Length != 2)
                    throw new InvalidOperationException("Dockerfile FROM instruction has no resolvable image reference.");
                ValidateFrom(parts[1], stages, stageCount);
                var alias = FromAlias().Match(parts[1]);
                if (alias.Success)
                    stages.Add(alias.Groups[1].Value);
                stageCount++;
            }
            else if (parts.Length == 2 && parts[0].Equals("COPY", StringComparison.OrdinalIgnoreCase))
            {
                var source = CopyFrom().Match(parts[1]);
                if (source.Success)
                {
                    var reference = source.Groups.Cast<Group>().Skip(1).First(group => group.Success).Value;
                    ValidateReference(reference, stages, stageCount, "COPY --from");
                }
            }
        }
    }

    private static void ValidateFrom(string arguments, HashSet<string> stages, int stageCount)
    {
        var match = FromImage().Match(arguments);
        if (!match.Success)
            throw new InvalidOperationException("Dockerfile FROM instruction has an unresolved or invalid image reference.");

        ValidateReference(match.Groups[1].Value, stages, stageCount, "FROM");
    }

    private static void ValidateReference(string reference, HashSet<string> stages, int stageCount, string instruction)
    {
        reference = reference.Trim('"', '\'');
        if (reference.Equals("scratch", StringComparison.OrdinalIgnoreCase) ||
            stages.Contains(reference) ||
            (int.TryParse(reference, out var index) && index >= 0 && index < stageCount))
            return;

        if (reference.Contains('$'))
            throw new InvalidOperationException($"Dockerfile {instruction} uses dynamic external image reference '{reference}'.");

        var digest = DigestReference().Match(reference);
        if (!digest.Success)
            throw new InvalidOperationException($"Dockerfile {instruction} external image '{reference}' must use an immutable sha256 digest.");

        var name = digest.Groups[1].Value;
        var isOfficialImage = !name.Contains('/') || name.StartsWith("docker.io/library/", StringComparison.Ordinal);
        var isMicrosoftDotnet = name.StartsWith("mcr.microsoft.com/dotnet/", StringComparison.Ordinal);
        if (!isOfficialImage && !isMicrosoftDotnet)
            throw new InvalidOperationException($"Dockerfile {instruction} external image '{reference}' is not from an approved registry namespace.");
    }

    private static IEnumerable<string> ReadInstructions(string dockerfile)
    {
        var logicalLine = "";
        using var reader = new StringReader(dockerfile);
        while (reader.ReadLine() is { } line)
        {
            var trimmed = line.Trim();
            if (logicalLine.Length == 0 && (trimmed.Length == 0 || trimmed.StartsWith('#')))
                continue;

            var continued = trimmed.EndsWith('\\');
            logicalLine += (logicalLine.Length == 0 ? "" : " ") + (continued ? trimmed[..^1] : trimmed);
            if (!continued)
            {
                yield return logicalLine.Trim();
                logicalLine = "";
            }
        }

        if (logicalLine.Length != 0)
            yield return logicalLine.Trim();
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    [GeneratedRegex("(?:^|\\s)--from(?:=|\\s+)(?:\"([^\"]+)\"|'([^']+)'|([^\\s]+))", RegexOptions.IgnoreCase)]
    private static partial Regex CopyFrom();

    [GeneratedRegex(@"^(?:--[^\s]+\s+)*([^\s]+)(?:\s+[Aa][Ss]\s+([A-Za-z0-9_.-]+))?\s*$")]
    private static partial Regex FromImage();

    [GeneratedRegex(@"\s+[Aa][Ss]\s+([A-Za-z0-9_.-]+)\s*$")]
    private static partial Regex FromAlias();

    [GeneratedRegex(@"^(.+?)(?::[^/@]+)?@sha256:([0-9a-f]{64})$")]
    private static partial Regex DigestReference();
}
