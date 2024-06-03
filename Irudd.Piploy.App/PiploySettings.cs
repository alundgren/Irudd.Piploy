using Microsoft.Extensions.Options;
using System.ComponentModel.DataAnnotations;

namespace Irudd.Piploy.App;

public class PiploySettings
{
    [Required]
    public string RootFolder { get; set; } = null!;

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
    }
}

