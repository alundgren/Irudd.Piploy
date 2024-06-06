using Microsoft.Extensions.Options;
using System.ComponentModel.DataAnnotations;

namespace Irudd.Piploy.App;

public class PiploySettings
{
    [Required]
    public string RootDirectory { get; set; } = null!;

    [Required]
    [ValidateEnumeratedItems]
    public List<Application> Applications { get; set; } = null!;

    public class Application
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

        public string GetRootDirectory(PiploySettings settings) => Path.Combine(settings.RootDirectory, Name);

        public string GetRepoDirectory(PiploySettings settings) => Path.Combine(GetRootDirectory(settings), "repo");
    }
}

