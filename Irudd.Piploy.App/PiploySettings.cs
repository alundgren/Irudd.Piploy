using Microsoft.Extensions.Options;
using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;

namespace Irudd.Piploy.App;

public class PiploySettings
{
    [Required]
    public string RootDirectory { get; set; } = null!;

    /// <summary>
    /// By default when running as a service we check for new versions of the apps
    /// every 60 minutes. Use this to changes that value.
    /// </summary>
    public int? MinutesBetweenBackgroundPolls { get; set; }

    [Required]
    [ValidateEnumeratedItems]
    public List<Application> Applications { get; set; } = null!;

    /// <summary>
    /// Adds a special marker label piploy_isCreatedByTest = "true" to the images
    /// so we can stop and delete everything between tests safely without nuking
    /// any real user images or containers on the same machine.
    /// </summary>
    public bool? IsTestRun { get; set; }

    public class Application : IValidatableObject
    {
        [Required]
        [RegularExpression(@"^[A-Za-z0-9_-]+$")]
        public string Name { get; set; } = null!;

        [Required]
        public string GitRepositoryUrl { get; set; } = null!;

        /// <summary>
        /// Relative path in the repo to the docker file.
        //  Example if there is just a single dockerfile in the root:
        //  "Dockerfile" or "/Dockerfile"
        //  Example if there are two docker files in different directories
        //  "/api/Dockerfile" "Ui/Dockerfile"
        //  Example with custom name of the file
        //  "api/DockerApiFile" or "/DockerApiFile"
        /// </summary>
        [Required]
        public string DockerfilePath { get; set; } = null!;

        /// <summary>
        /// Same format as docker run -p <hostport>:<containerport>
        /// So for example to map an nginx container using port 80 to serve web content 
        /// onto port 8080 on the host use: TcpPortMappings = ["8080:80"]
        /// 
        /// We only support tcp and only single port to single port.
        /// </summary>
        public List<string>? PortMappings { get; set; }

        public List<(int HostPort, int ContainerPort)> GetPortMappings() => 
            ParsePortMappings(x => x, errorMessage => throw new Exception(errorMessage));

        private T ParsePortMappings<T>(Func<List<(int HostPort, int ContainerPort)>, T> onSuccess, Func<string, T> onError)
        {
            var mappings = new List<(int HostPort, int ContainerPort)>();
            var pattern = new Regex(@"^(\d+):(\d+)$");
            foreach(var mappingString in (PortMappings ?? Enumerable.Empty<string>()))
            {
                var match = pattern.Match(mappingString);
                if (!match.Success)
                    return onError("Invalid port mappings. Must have the format <hostPort>:<containerPort>");
                mappings.Add((
                    int.Parse(match.Groups[1].Value), 
                    int.Parse(match.Groups[2].Value)));
            }

            return onSuccess(mappings);
        }

        public string GetRootDirectory(PiploySettings settings) => Path.Combine(settings.RootDirectory, Name);

        public string GetRepoDirectory(PiploySettings settings) => Path.Combine(GetRootDirectory(settings), "repo");

        public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
        {
            var portMappingsError = ParsePortMappings(
                mappings => null, 
                errorMessage => (ValidationResult?)new ValidationResult(errorMessage, [nameof(PortMappings)]));
            if (portMappingsError != null)
                yield return portMappingsError;
        }
    }
}

