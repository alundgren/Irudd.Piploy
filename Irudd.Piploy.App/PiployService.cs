using Microsoft.Extensions.Options;

namespace Irudd.Piploy.App;

public class PiployService(IOptions<PiploySettings> settings)
{
    private PiploySettings Settings => settings.Value;

    /// <summary>
    /// Make sure we have up to date copies of all the applications git repositories.
    /// </summary>
    public async Task EnsureLocalRepositoriesAsync()
    {
        if (!Directory.Exists(Settings.RootFolder))
            Directory.CreateDirectory(Settings.RootFolder);
    }
}
